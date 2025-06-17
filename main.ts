import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenAI, createUserContent, createPartFromUri } from "npm:@google/genai";

// 配置Google GenAI API
const API_KEY = "AIzaSyAPgNkJpYrO90jKlG4Y3v1jdrAsM2A-_Yc";
const MODEL = "gemini-2.5-flash-preview-05-20";

// 创建AI客户端
const ai = new GoogleGenAI({ apiKey: API_KEY });

// 处理上传的文件并调用Gemini API
async function handleFileUpload(formData: FormData) {
  try {
    // 从FormData中获取文件
    const file = formData.get("file");
    
    if (!file || !(file instanceof Blob)) {
      return new Response(JSON.stringify({ error: "没有找到文件或文件格式不正确" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    // 获取文件类型
    const mimeType = file.type || "application/octet-stream";
    
    // 获取提示文本（如果有）
    const prompt = formData.get("prompt") || "描述这个文件内容";
    
    // 上传文件到Gemini
    const uploadedFile = await ai.files.upload({
      file: file,
      config: { mimeType },
    });
    
    // 获取文件详细信息
    const fileName = uploadedFile.name;
    const fetchedFile = await ai.files.get({ name: fileName });
    
    // 调用Gemini API生成内容
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: createUserContent([
        createPartFromUri(uploadedFile.uri, mimeType),
        prompt.toString(),
      ]),
    });
    
    // 返回Gemini的完整响应，包括文件信息
    return new Response(JSON.stringify({
      success: true,
      result: response,
      file_info: {
        uploaded_file: uploadedFile,
        fetched_file: fetchedFile
      }
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

// 处理直接发送的JSON请求（包含URI信息）
async function handleJsonRequest(data: any) {
  try {
    if (!data || !data.content) {
      return new Response(JSON.stringify({ error: "请求格式不正确，缺少content字段" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 提取请求内容
    const { content, prompt } = data;
    
    // 检查是否包含文件URI信息
    if (!content.fileData || !content.fileData.uri || !content.fileData.mimeType) {
      return new Response(JSON.stringify({ error: "请求格式不正确，缺少文件URI信息" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    
    // 从请求中提取URI和mimeType
    const { uri, mimeType } = content.fileData;
    const userPrompt = prompt || "描述这个内容";
    
    // 调用Gemini API生成内容
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: createUserContent([
        createPartFromUri(uri, mimeType),
        userPrompt,
      ]),
    });
    
    // 返回Gemini的完整响应
    return new Response(JSON.stringify({
      success: true,
      result: response,
      request_info: {
        uri: uri,
        mimeType: mimeType,
        prompt: userPrompt
      }
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
