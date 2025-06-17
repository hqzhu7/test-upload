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
    let uri;
    let mimeType;
    
    // 检查是否提供了FileURL参数
    if (data.FileURL && typeof data.FileURL === "string") {
      // 从URL获取并上传文件
      const result = await fetchAndUploadFile(data.FileURL);
      uri = result.uploadedFile.uri;
      mimeType = result.mimeType;
    } else if (data.uri) {
      // 使用提供的uri
      uri = data.uri;
      mimeType = data.mimeType || "image/jpeg";
    } else if (data.content && data.content.fileData && data.content.fileData.uri) {
      // 从请求中提取URI和mimeType
      uri = data.content.fileData.uri;
      mimeType = data.content.fileData.mimeType;
    } else {
      return new Response(JSON.stringify({ error: "缺少必要的uri参数或FileURL参数" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    // 使用默认的提示文本（如果未提供）
    const userPrompt = data.prompt || "描述这个文件内容";
    
    // 调用Gemini API生成内容
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: createUserContent([
        createPartFromUri(uri, mimeType),
        userPrompt,
      ]),
    });
    
    // 返回简化的响应，只包含content、uri和mimeType
    return new Response(JSON.stringify({
      success: true,
      content: response.candidates?.[0]?.content?.parts?.[0]?.text || "",
      uri: uri,
      mimeType: mimeType
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
