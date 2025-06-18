import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenAI, createUserContent, createPartFromUri } from "npm:@google/genai";

// 配置Google GenAI API
const API_KEY = "AIzaSyAPgNkJpYrO90jKlG4Y3v1jdrAsM2A-_Yc";
const MODEL = "gemini-2.5-flash-preview-05-20";

// 创建AI客户端
const ai = new GoogleGenAI({ apiKey: API_KEY });

// 从URL获取文件并上传到Gemini
async function fetchAndUploadFile(url: string) {
  try {
    // 获取远程文件
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`获取文件失败: ${response.status} ${response.statusText}`);
    }
    
    // 获取文件类型
    const mimeType = response.headers.get("Content-Type") || "application/octet-stream";
    
    // 转换为Blob
    const blob = await response.blob();
    
    // 上传文件到Gemini
    const uploadedFile = await ai.files.upload({
      file: blob,
      config: { mimeType },
    });
    
    return { uploadedFile, mimeType };
  } catch (error) {
    console.error("获取或上传文件时出错:", error);
    throw error;
  }
}

// 处理上传的文件并调用Gemini API
async function handleFileUpload(formData: FormData) {
  try {
    let uploadedFile;
    let mimeType;
    
    // 检查是否提供了FileURL参数
    const fileUrl = formData.get("FileURL");
    
    if (fileUrl && typeof fileUrl === "string") {
      // 从URL获取并上传文件
      const result = await fetchAndUploadFile(fileUrl);
      uploadedFile = result.uploadedFile;
      mimeType = result.mimeType;
    } else {
      // 从FormData中获取文件
      const file = formData.get("file");
      
      if (!file || !(file instanceof Blob)) {
        return new Response(JSON.stringify({ error: "没有找到文件或文件格式不正确，也没有提供有效的FileURL" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      // 获取文件类型
      mimeType = file.type || "application/octet-stream";
      
      // 上传文件到Gemini
      uploadedFile = await ai.files.upload({
        file: file,
        config: { mimeType },
      });
    }
    
    // 获取提示文本（如果有）
    const prompt = formData.get("prompt") || "描述这个文件内容";
    
    // 调用Gemini API生成内容
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: createUserContent([
        createPartFromUri(uploadedFile.uri, mimeType),
        prompt.toString(),
      ]),
    });
    
    // 返回简化的响应，只包含content、uri和mimeType
    return new Response(JSON.stringify({
      success: true,
      content: response.candidates?.[0]?.content?.parts?.[0]?.text || "",
      uri: uploadedFile.uri,
      mimeType: mimeType
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("处理文件时出错:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// 处理JSON请求并调用Gemini API
async function handleJsonRequest(data: any) {
  try {
    // 检查是否有新格式的请求结构
    const hasNewFormat = data.newchat !== undefined;
    let userPrompt = "描述这个文件内容";
    let fileURLs: string[] = [];
    let messageHistory: any[] = [];
    
    // 处理新格式的请求
    if (hasNewFormat) {
      // 获取newchat中的输入内容
      if (data.newchat.input) {
        userPrompt = data.newchat.input;
      }
      
      // 获取newchat中的fileURL(s)
      if (data.newchat.fileURL) {
        if (Array.isArray(data.newchat.fileURL)) {
          fileURLs = data.newchat.fileURL.filter(url => typeof url === "string");
        } else if (typeof data.newchat.fileURL === "string") {
          fileURLs = [data.newchat.fileURL];
        }
      }
      
      // 获取MessageHistory
      if (data.MessageHistory && Array.isArray(data.MessageHistory)) {
        messageHistory = data.MessageHistory;
      }
    } else {
      // 处理旧格式的请求
      userPrompt = data.prompt || userPrompt;
      
      // 检查是否提供了FileURL参数
      if (data.FileURL) {
        if (Array.isArray(data.FileURL)) {
          fileURLs = data.FileURL.filter(url => typeof url === "string");
        } else if (typeof data.FileURL === "string") {
          fileURLs = [data.FileURL];
        }
      }
    }
    
    // 处理文件上传
    const uploadedFiles = [];
    if (fileURLs.length > 0) {
      // 并行上传所有文件
      const uploadPromises = fileURLs.map(url => fetchAndUploadFile(url));
      const results = await Promise.all(uploadPromises);
      
      for (const result of results) {
        uploadedFiles.push({
          uri: result.uploadedFile.uri,
          mimeType: result.mimeType
        });
      }
    } else if (!hasNewFormat) {
      // 处理旧格式中的uri参数
      if (data.uri) {
        uploadedFiles.push({
          uri: data.uri,
          mimeType: data.mimeType || "image/jpeg"
        });
      } else if (data.content && data.content.fileData && data.content.fileData.uri) {
        uploadedFiles.push({
          uri: data.content.fileData.uri,
          mimeType: data.content.fileData.mimeType || "image/jpeg"
        });
      }
    }
    
    // 如果没有文件且不是新格式，返回错误
    if (uploadedFiles.length === 0 && !hasNewFormat && messageHistory.length === 0) {
      return new Response(JSON.stringify({ error: "缺少必要的uri参数或FileURL参数" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    // 准备Gemini API请求内容
    let contents: any;
    
    // 如果有历史记录，处理历史记录
    if (messageHistory.length > 0) {
      // 转换历史记录为Gemini API格式
      const formattedHistory = messageHistory.map(msg => {
        // 简单检查消息格式，避免过度验证影响性能
        const role = msg.role === "user" ? "user" : "model";
        
        // 处理包含文件数据的消息
        if (msg.fileData && msg.fileData.uri) {
          return {
            role,
            parts: [
              { inlineData: { mimeType: msg.fileData.mimeType || "image/jpeg", data: msg.fileData.uri } },
              { text: msg.content || "" }
            ]
          };
        }
        
        // 处理纯文本消息
        return {
          role,
          parts: [{ text: msg.content || "" }]
        };
      });
      
      // 添加当前用户消息
      const currentUserParts = [];
      
      // 添加上传的文件
      for (const file of uploadedFiles) {
        currentUserParts.push(createPartFromUri(file.uri, file.mimeType));
      }
      
      // 添加用户提示文本
      currentUserParts.push(userPrompt);
      
      // 创建完整的请求内容
      contents = [...formattedHistory, createUserContent(currentUserParts)];
    } else {
      // 没有历史记录，只使用当前消息
      const parts = [];
      
      // 添加上传的文件
      for (const file of uploadedFiles) {
        parts.push(createPartFromUri(file.uri, file.mimeType));
      }
      
      // 添加用户提示文本
      parts.push(userPrompt);
      
      contents = createUserContent(parts);
    }
    
    // 调用Gemini API生成内容
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: contents,
    });
    
    // 返回简化的响应
    return new Response(JSON.stringify({
      success: true,
      content: response.candidates?.[0]?.content?.parts?.[0]?.text || "",
      uri: uploadedFiles.length > 0 ? uploadedFiles.map(f => f.uri) : undefined,
      mimeType: uploadedFiles.length > 0 ? uploadedFiles.map(f => f.mimeType) : undefined
    }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("处理JSON请求时出错:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// 处理请求
async function handler(req: Request): Promise<Response> {
  // 允许跨域请求
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  
  // 处理预检请求
  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }
  
  // 只接受POST请求
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "只支持POST请求" }), {
      status: 405,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  
  try {
    // 检查Content-Type
    const contentType = req.headers.get("Content-Type") || "";
    
    if (contentType.includes("multipart/form-data")) {
      // 处理表单数据
      const formData = await req.formData();
      return await handleFileUpload(formData);
    } else if (contentType.includes("application/json")) {
      // 处理JSON请求
      const data = await req.json();
      return await handleJsonRequest(data);
    } else {
      return new Response(JSON.stringify({ error: "请使用multipart/form-data格式上传文件或application/json格式发送请求" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  } catch (error) {
    console.error("处理请求时出错:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
}

// 启动服务器
console.log("启动服务器在端口8000...");
serve(handler, { port: 8000 });

