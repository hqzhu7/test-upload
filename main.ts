import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenAI, createUserContent, createPartFromUri } from "npm:@google/genai";

// 配置Google GenAI API
// 注意: 确保你的 API_KEY 是有效的
const API_KEY = "AIzaSyAPgNkJpYrO90jKlG4Y3v1jdrAsM2A-_Yc"; 
const MODEL = "gemini-2.5-flash-preview-05-20";

// 创建AI客户端
const ai = new GoogleGenAI({ apiKey: API_KEY });

// 辅助函数：从URL获取文件并上传到Gemini File API
async function fetchAndUploadFile(url: string) {
  try {
    // 获取远程文件
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch file from URL: ${url}, Status: ${response.status} ${response.statusText}`);
    }
    
    // 获取文件类型，如果无法确定则默认为八位字节流
    const mimeType = response.headers.get("Content-Type") || "application/octet-stream";
    
    // 转换为Blob
    const blob = await response.blob();
    
    // 上传文件到Gemini File API
    const uploadedFile = await ai.files.upload({
      file: blob,
      config: { mimeType },
    });
    
    return { uploadedFile, mimeType };
  } catch (error) {
    console.error(`Error fetching or uploading file from ${url}:`, error);
    throw error; // 重新抛出错误以便上层捕获
  }
}

// 主请求处理函数：处理来自扣子工具的 JSON 请求
async function handleJsonRequest(data: any) {
  try {
    const finalContents: any[] = []; // 最终发送给 Gemini API 的 contents 数组

    // --- 1. 处理 MessageHistory (历史对话记录) ---
    // 扣子工具发送的 MessageHistory 已经是 Gemini API contents 格式的数组
    // 但内部的 parts 需要进一步处理，特别是 fileData.uri
    if (data.MessageHistory && Array.isArray(data.MessageHistory)) {
      for (const historyItem of data.MessageHistory) {
        // 验证 historyItem 结构
        if (typeof historyItem.role !== "string" || !Array.isArray(historyItem.parts)) {
          console.warn("Skipping malformed history item:", historyItem);
          continue; // 跳过格式不正确的历史项
        }

        const geminiPartsForHistory: any[] = [];
        for (const part of historyItem.parts) {
          if (typeof part.text === "string") {
            geminiPartsForHistory.push(part.text);
          } else if (part.fileData && typeof part.fileData.uri === "string") {
            // 检查 URI 是否已经是 Gemini File API 的引用
            if (part.fileData.uri.startsWith("file://") || part.fileData.uri.startsWith("https://generativelanguage.googleapis.com/v1beta/files/")) {
              geminiPartsForHistory.push(createPartFromUri(part.fileData.uri, part.fileData.mimeType || "image/jpeg"));
            } else {
              // 外部 URL 需要重新上传到 Gemini File API
              const { uploadedFile, mimeType } = await fetchAndUploadFile(part.fileData.uri);
              geminiPartsForHistory.push(createPartFromUri(uploadedFile.uri, mimeType));
            }
          }
        }
        
        // 只有当历史项包含有效内容时才添加
        if (geminiPartsForHistory.length > 0) {
          finalContents.push(createUserContent(geminiPartsForHistory, historyItem.role));
        }
      }
    }

    // --- 2. 处理 newchat (当前用户消息) ---
    // 扣子工具发送的 newchat 是一个对象，包含 input (text) 和 fileURL
    const currentUserParts: any[] = [];
    if (data.newchat) {
      if (typeof data.newchat.input === "string") {
        currentUserParts.push(data.newchat.input);
      }

      // newchat.fileURL 可以是字符串或字符串数组
      let currentFileURLs: string[] = [];
      if (typeof data.newchat.fileURL === "string") {
        currentFileURLs = [data.newchat.fileURL];
      } else if (Array.isArray(data.newchat.fileURL)) {
        currentFileURLs = data.newchat.fileURL.filter((url: any) => typeof url === "string");
      }

      for (const url of currentFileURLs) {
        // 当前消息的文件总是需要上传到 Gemini File API (除非它已经是 Gemini URI)
        if (url.startsWith("file://") || url.startsWith("https://generativelanguage.googleapis.com/v1beta/files/")) {
            currentUserParts.push(createPartFromUri(url, "image/jpeg")); // 假设是图片，或需要更智能的MIME判断
        } else {
            const { uploadedFile, mimeType } = await fetchAndUploadFile(url);
            currentUserParts.push(createPartFromUri(uploadedFile.uri, mimeType));
        }
      }
    }

    // 如果当前用户有任何内容，添加到 finalContents
    if (currentUserParts.length > 0) {
      finalContents.push(createUserContent(currentUserParts, "user"));
    }

    // --- 3. 最终校验 ---
    if (finalContents.length === 0) {
      return new Response(JSON.stringify({ error: "No valid content found in newchat or MessageHistory to send to Gemini." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- 4. 调用 Gemini API ---
    console.log("Sending contents to Gemini:", JSON.stringify(finalContents, null, 2)); // 打印发送给Gemini的内容
    const geminiResponse = await ai.models.generateContent({
      model: MODEL,
      contents: finalContents,
    });
    
    // 从Gemini响应中提取文本内容
    const generatedText = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // --- 5. 返回结果 ---
    return new Response(JSON.stringify({
      success: true,
      response: generatedText, // 将 Gemini 生成的文本放在 'response' 字段
      // 根据你的需求，这里可以返回更多信息，例如第一个上传文件的 URI
      // 如果需要返回多个文件 URI/MIME Type，则需要更复杂的结构
      // 这里只是一个简化示例，返回原始 fileURLs 作为参考
      uploaded_file_urls: (data.newchat && (typeof data.newchat.fileURL === "string" || Array.isArray(data.newchat.fileURL))) ? data.newchat.fileURL : undefined,
    }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error in handleJsonRequest:", error);
    return new Response(JSON.stringify({ 
      success: false,
      response: `Internal Server Error: ${error.message || "Unknown error"}`,
      details: error.stack // 方便调试，但在生产环境可能不适合直接返回
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// 全局请求处理函数
async function handler(req: Request): Promise<Response> {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  
  // 处理预检请求 (CORS)
  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }
  
  // 只接受 POST 请求
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST method is allowed." }), {
      status: 405,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  
  try {
    const contentType = req.headers.get("Content-Type") || "";
    
    // 只处理 application/json 类型
    if (contentType.includes("application/json")) {
      const data = await req.json();
      console.log("Received JSON data from Coze tool:", JSON.stringify(data, null, 2)); // 打印接收到的数据
      return await handleJsonRequest(data);
    } else {
      return new Response(JSON.stringify({ error: "Unsupported Content-Type. Please use application/json." }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  } catch (error: any) {
    console.error("Error processing request:", error);
    return new Response(JSON.stringify({ 
      success: false,
      response: `Request processing failed: ${error.message || "Unknown error"}`,
      details: error.stack
    }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
}

// 启动服务器
console.log("Deno Deploy server started on port 8000...");
serve(handler, { port: 8000 });
