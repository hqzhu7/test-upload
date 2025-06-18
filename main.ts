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
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch file from URL: ${url}, Status: ${response.status} ${response.statusText}`);
    }
    
    const mimeType = response.headers.get("Content-Type") || "application/octet-stream";
    const blob = await response.blob();
    
    const uploadedFile = await ai.files.upload({
      file: blob,
      config: { mimeType },
    });
    
    return { uploadedFile, mimeType };
  } catch (error) {
    console.error(`Error fetching or uploading file from ${url}:`, error);
    throw error;
  }
}

// 主请求处理函数：处理来自扣子工具的 JSON 请求
async function handleJsonRequest(data: any) {
  try {
    const finalContents: any[] = [];
    const newlyUploadedFilesInfo: { uri: string; mimeType: string }[] = []; 

    // --- 1. 处理 MessageHistory (历史对话记录) ---
    if (data.MessageHistory && Array.isArray(data.MessageHistory)) {
      for (const historyItem of data.MessageHistory) {
        if (typeof historyItem.role !== "string" || !Array.isArray(historyItem.parts)) {
          console.warn("Skipping malformed history item:", historyItem);
          continue; 
        }

        const geminiPartsForHistory: any[] = [];
        for (const part of historyItem.parts) {
          if (typeof part.text === "string") {
            geminiPartsForHistory.push(part.text);
          } 
          
          if (part.fileData && typeof part.fileData.uri === "string") {
            let fileUriToUse = part.fileData.uri;
            let fileMimeType = part.fileData.mimeType || "image/jpeg";

            if (!fileUriToUse.startsWith("file://") && !fileUriToUse.startsWith("https://generativelanguage.googleapis.com/v1beta/files/")) {
              const { uploadedFile, mimeType } = await fetchAndUploadFile(fileUriToUse);
              fileUriToUse = uploadedFile.uri; 
              fileMimeType = mimeType; 
              newlyUploadedFilesInfo.push({ uri: fileUriToUse, mimeType: fileMimeType }); 
            }
            geminiPartsForHistory.push(createPartFromUri(fileUriToUse, fileMimeType));
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

      let currentFileURLs: string[] = [];
      if (Array.isArray(data.newchat.fileURL)) {
        currentFileURLs = data.newchat.fileURL.filter((url: any) => typeof url === "string");
      } else if (typeof data.newchat.fileURL === "string" && data.newchat.fileURL.includes(',')) {
        currentFileURLs = data.newchat.fileURL.split(',').map((url: string) => url.trim()).filter(Boolean);
      } else if (typeof data.newchat.fileURL === "string") {
        currentFileURLs = [data.newchat.fileURL];
      }

      for (const url of currentFileURLs) {
        const { uploadedFile, mimeType } = await fetchAndUploadFile(url);
        newlyUploadedFilesInfo.push({ uri: uploadedFile.uri, mimeType: mimeType }); 
        currentUserParts.push(createPartFromUri(uploadedFile.uri, mimeType));
      }
    }

    if (currentUserParts.length === 0 && finalContents.length === 0) {
      return new Response(JSON.stringify({ 
        success: false,
        response: "No valid content found in newchat or MessageHistory to send to Gemini.",
        fileDatas: [] // 明确返回空数组
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- 3. 调用 Gemini API ---
    console.log("Sending contents to Gemini:", JSON.stringify(finalContents.concat(createUserContent(currentUserParts, "user")), null, 2)); 
    const geminiResponse = await ai.models.generateContent({
      model: MODEL,
      contents: finalContents.concat(createUserContent(currentUserParts, "user")),
    });
    
    const generatedText = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // --- 4. 返回结果 (精简格式) ---
    return new Response(JSON.stringify({
      success: true,
      response: generatedText, 
      fileDatas: newlyUploadedFilesInfo // 精简为 fileDatas
    }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error in handleJsonRequest:", error);
    return new Response(JSON.stringify({ 
      success: false,
      response: `Internal Server Error: ${error.message || "Unknown error"}`,
      fileDatas: [], // 错误时也返回空数组
      details: error.stack // 错误详情保留
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// 全局请求处理函数 (保持不变)
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
      fileDatas: [], // 错误时也返回空数组
      details: error.stack
    }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
}

// 启动服务器 (保持不变)
console.log("Deno Deploy server started on port 8000...");
serve(handler, { port: 8000 });
