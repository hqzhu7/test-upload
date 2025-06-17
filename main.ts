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
    
    // 调用Gemini API生成内容
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: createUserContent([
        createPartFromUri(uploadedFile.uri, mimeType),
        prompt.toString(),
      ]),
    });
    
    // 返回Gemini的完整响应
    return new Response(JSON.stringify({
      success: true,
      result: response,
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
    } else {
      return new Response(JSON.stringify({ error: "请使用multipart/form-data格式上传文件" }), {
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
