import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenAI, createUserContent, createPartFromUri } from "npm:@google/genai";

// 配置Google GenAI API
// 注意: 确保你的 API_KEY 是有效的
const API_KEY = "AIzaSyAPgNkJpYrO90jKlG4Y3v1jdrAsM2A-_Yc"; 
const MODEL = "gemini-2.5-flash-preview-05-20"; // 建议使用最新的稳定模型

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
    if (data.MessageHistory && Array.isArray(data.MessageHistory)) {
      for (const historyItem of data.MessageHistory) {
        if (typeof historyItem.role !== "string" || !Array.isArray(historyItem.parts)) {
          console.warn("Skipping malformed history item:", historyItem);
          continue; 
        }

        const geminiPartsForHistory: any[] = [];
        for (const part of historyItem.parts) {
          // 优先处理文本部分
          if (typeof part.text === "string") {
            geminiPartsForHistory.push(part.text);
          } 
          // 独立处理文件部分
          if (part.fileData && typeof part.fileData.uri === "string") {
            // 检查 URI 是否已经是 Gemini File API 的引用，或者需要上传
            if (part.fileData.uri.startsWith("file://") || part.fileData.uri.startsWith("https://generativelanguage.googleapis.com/v1beta/files/")) {
              geminiPartsForHistory.push(createPartFromUri(part.fileData.uri, part.fileData.mimeType || "image/jpeg"));
            } else {
              // 外部 URL 需要重新上传到 Gemini File API
              const { uploadedFile, mimeType } = await fetchAndUploadFile(part.fileData.uri);
              geminiPartsForHistory.push(createPartFromUri(uploadedFile.uri, mimeType));
            }
          }
        }
        
        if (geminiPartsForHistory.length > 0) {
          finalContents.push(createUserContent(geminiPartsForHistory, historyItem.role));
        }
      }
    }

    // --- 2. 处理 newchat (当前用户消息) ---
    const currentUserParts: any[] = [];
    if (data.newchat) {
      if (typeof data.newchat.input === "string") {
        currentUserParts.push(data.newchat.input);
      }

      // newchat.fileURL 总是作为数组处理 (由扣子工具确保是数组)
      let currentFileURLs: string[] = [];
      if (Array.isArray(data.newchat.fileURL)) { // 期望扣子工具已经处理成数组
        currentFileURLs = data.newchat.fileURL.filter((url: any) => typeof url === "string");
      } else if (typeof data.newchat.fileURL === "string" && data.newchat.fileURL.includes(',')) {
        // 尽管扣子工具会处理，但仍保留一个兜底，以防万一直接收到逗号分隔的字符串
        currentFileURLs = data.newchat.fileURL.split(',').map((url: string) => url.trim()).filter(Boolean);
      } else if (typeof data.newchat.fileURL === "string") {
        currentFileURLs = [data.newchat.fileURL];
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
    console.log("Sending contents to Gemini:", JSON.stringify(finalContents, null, 2)); 
    const geminiResponse = await ai.models.generateContent({
      model: MODEL,
      contents: finalContents,
    });
    
    const generatedText = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // --- 5. 返回结果 ---
    return new Response(JSON.stringify({
      success: true,
      response: generatedText, 
    }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error in handleJsonRequest:", error);
    return new Response(JSON.stringify({ 
      success: false,
      response: `Internal Server Error: ${error.message || "Unknown error"}`,
      details: error.stack 
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
  
  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }
  
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST method is allowed." }), {
      status: 405,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  
  try {
    const contentType = req.headers.get("Content-Type") || "";
    
    if (contentType.includes("application/json")) {
      const data = await req.json();
      console.log("Received JSON data from Coze tool:", JSON.stringify(data, null, 2)); 
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
