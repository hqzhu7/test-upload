import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenAI, createUserContent, createPartFromUri } from "npm:@google/genai";

// 移除硬编码的 API_KEY 和 MODEL
// const API_KEY = "AIzaSyAPgNkJpYrO90jKlG4Y3v1jdrAsM2A-_Yc"; // 替换为你的 Gemini API Key
// const MODEL = "gemini-2.5-flash-preview-05-20"; // 默认模型，但现在可以动态覆盖

// AI客户端的初始化将移到 handleJsonRequest 内部，以便使用动态 API Key
let ai: GoogleGenAI; 

// 辅助函数：从URL获取文件并上传到Gemini File API
async function fetchAndUploadFile(url: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch file from URL: ${url}, Status: ${response.status} ${response.statusText}`);
    }

    const mimeType = response.headers.get("Content-Type") || "application/octet-stream";
    const blob = await response.blob();

    console.log(`Uploading file to Gemini: URL=${url}, MimeType=${mimeType}, Size=${blob.size} bytes`);
    const uploadedFile = await ai.files.upload({ // 这里使用外部的 ai 实例
      file: blob,
      config: { mimeType },
    });
    console.log(`File uploaded to Gemini: ${uploadedFile.uri}, DisplayName: ${uploadedFile.displayName}`);

    return { uploadedFile, mimeType };
  } catch (error) {
    console.error(`Error fetching or uploading file from "${url}":`, error);
    throw error; // 重新抛出错误以便上层捕获
  }
}

// 主请求处理函数：处理来自Coze工具的 JSON 请求
async function handleJsonRequest(data: any) {
  try {
    const finalContents: any[] = [];
    const newlyUploadedFilesInfo: { uri: string; mimeType: string }[] = [];

    // --- 获取动态参数 ---
    const apiKey = data.API_KEY; // 从请求中获取 API_KEY
    if (!apiKey) {
      return new Response(JSON.stringify({
        success: false,
        response: "API_KEY is missing in the request payload.",
        fileDatas: []
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    // 每次请求都使用动态的 API_KEY 初始化 AI 客户端
    ai = new GoogleGenAI({ apiKey: apiKey });

    // 获取 temperature
    const temperature = typeof data.temperature === 'number' ? data.temperature : undefined; // 如果不是 number，设为 undefined，让模型使用默认值
    console.log(`Using temperature: ${temperature}`);

    // 获取 systemInstruction
    const defaultSystemInstruction = "你是智能助手，你一直用中文回复解决问题。";
    const systemInstruction = typeof data.systemInstruction === 'string' && data.systemInstruction.trim() !== ''
        ? data.systemInstruction
        : defaultSystemInstruction;
    console.log(`Using systemInstruction: ${systemInstruction}`);

    // 获取 modelName，如果请求中没有，使用默认值
    const modelName = typeof data.modelName === 'string' && data.modelName.trim() !== ''
        ? data.modelName
        : "gemini-2.5-flash-preview-05-20"; // 默认模型
    console.log(`Using model: ${modelName}`);

    // --- 1. 处理 MessageHistory (历史对话记录) ---
    if (data.MessageHistory && Array.isArray(data.MessageHistory)) {
      console.log(`Processing MessageHistory: ${data.MessageHistory.length} items`);
      for (const historyItem of data.MessageHistory) {
        if (typeof historyItem !== "object" || historyItem === null || typeof historyItem.role !== "string") {
          console.warn("Skipping malformed history item (not object or missing role):", historyItem);
          continue;
        }

        const geminiPartsForHistory: any[] = [];
        
        if (typeof historyItem.text === "string" && historyItem.text.trim()) {
          geminiPartsForHistory.push({ text: historyItem.text }); 
          console.log(`Added history text for role '${historyItem.role}': ${historyItem.text.substring(0, Math.min(historyItem.text.length, 50))}...`);
        }

        const rawFileData = historyItem.filedata;
        let parsedFileData: any[] = [];

        // 明确处理空字符串
        if (typeof rawFileData === "string" && rawFileData.trim() === "") {
            console.log(`Skipping empty filedata string for role '${historyItem.role}'.`);
            parsedFileData = []; 
        }
        else if (typeof rawFileData === "string" && rawFileData.trim()) {
            try {
                parsedFileData = JSON.parse(rawFileData);
                console.log(`Parsed filedata string for role '${historyItem.role}':`, parsedFileData);
            } catch (parseError) {
                console.warn(`Failed to parse filedata string for role '${historyItem.role}' as JSON, treating as empty: ${rawFileData}`, parseError);
                parsedFileData = [];
            }
        } else if (Array.isArray(rawFileData)) {
            parsedFileData = rawFileData;
            console.log(`Received filedata as array for role '${historyItem.role}':`, parsedFileData);
        } else if (rawFileData !== undefined && rawFileData !== null) {
            console.warn(`Unsupported filedata type for role '${historyItem.role}': ${typeof rawFileData}`, rawFileData);
        }

        if (Array.isArray(parsedFileData)) {
            for (const fileDataItem of parsedFileData) {
                if (typeof fileDataItem === "object" && fileDataItem !== null &&
                    typeof fileDataItem.uri === "string" && fileDataItem.uri.trim() &&
                    typeof fileDataItem.mimeType === "string" && fileDataItem.mimeType.trim()) {
                    
                    let fileUriToUse = fileDataItem.uri;
                    let fileMimeType = fileDataItem.mimeType;

                    if (!fileUriToUse.startsWith("file://") && !fileUriToUse.startsWith("https://generativelanguage.googleapis.com/v1beta/files/")) {
                        try {
                            const { uploadedFile, mimeType } = await fetchAndUploadFile(fileUriToUse);
                            fileUriToUse = uploadedFile.uri;
                            fileMimeType = mimeType;
                            newlyUploadedFilesInfo.push({ uri: fileUriToUse, mimeType: fileMimeType });
                            console.log(`Uploaded and added new file from history: ${fileUriToUse}`);
                        } catch (uploadError) {
                            console.error(`Failed to upload file from history (${fileUriToUse}):`, uploadError);
                            continue; 
                        }
                    } else {
                        console.log(`Using existing file URI from history: ${fileUriToUse}`);
                    }
                    geminiPartsForHistory.push(createPartFromUri(fileUriToUse, fileMimeType));
                } else {
                    console.warn("Skipping malformed fileDataItem in history (missing uri/mimeType or not object):", fileDataItem);
                }
            }
        }

        if (geminiPartsForHistory.length > 0) {
          finalContents.push(createUserContent(geminiPartsForHistory, historyItem.role));
          console.log(`Added history content for role '${historyItem.role}' to finalContents.`);
        } else {
            console.log(`History item for role '${historyItem.role}' has no valid parts, skipping.`);
        }
      }
    } else {
        console.log("No valid MessageHistory found or it's not an array.");
    }

    // --- 2. 处理 input (当前用户消息文本) 和 fileURL (当前用户消息文件) ---
    const currentUserParts: any[] = [];
    
    const userInput = data.input; 
    if (typeof userInput === "string" && userInput.trim()) {
      currentUserParts.push({ text: userInput }); 
      console.log(`Added current user input text: ${userInput.substring(0, Math.min(userInput.length, 50))}...`);
    } else {
        console.log("Current user input is missing or not a valid string.");
    }

    const userFileURL = data.fileURL; 
    let currentFileURLs: string[] = [];

    if (Array.isArray(userFileURL)) {
        currentFileURLs = userFileURL.filter((url: any) => typeof url === "string" && url.trim());
        console.log(`Received current fileURL as array: ${currentFileURLs.length} items`);
    } 
    else if (typeof userFileURL === "string" && userFileURL.trim()) {
        try {
            const parsed = JSON.parse(userFileURL);
            if (Array.isArray(parsed)) {
                currentFileURLs = parsed.filter((url: any) => typeof url === "string" && url.trim());
                console.log(`Parsed fileURL string as array: ${currentFileURLs.length} items`);
            } else {
                console.warn(`fileURL string parsed to non-array type, treating as single URL: ${userFileURL}`);
                currentFileURLs = [userFileURL.trim()];
                console.log(`Received current fileURL as single string (JSON parsed to non-array): ${currentFileURLs[0]}`);
            }
        } catch (e) {
            console.warn(`Failed to parse fileURL string as JSON, attempting comma split or single URL: ${userFileURL}`, e);
            if (userFileURL.includes(',')) {
                currentFileURLs = userFileURL.split(',').map((url: string) => url.trim()).filter(Boolean);
                console.log(`Received current fileURL as comma-separated string: ${currentFileURLs.length} items`);
            } else {
                currentFileURLs = [userFileURL.trim()];
                console.log(`Received current fileURL as single string (JSON parse failed): ${currentFileURLs[0]}`);
            }
        }
    } else {
        console.log("No valid current fileURL found or it's not an array/string.");
    }

    for (const url of currentFileURLs) {
        try {
            const { uploadedFile, mimeType } = await fetchAndUploadFile(url);
            newlyUploadedFilesInfo.push({ uri: uploadedFile.uri, mimeType: mimeType });
            currentUserParts.push(createPartFromUri(uploadedFile.uri, mimeType));
            console.log(`Uploaded and added new file from current input: ${url}`);
        } catch (uploadError) {
            console.error(`Failed to upload file from current input (${url}):`, uploadError);
        }
    }

    if (currentUserParts.length > 0) {
        finalContents.push(createUserContent(currentUserParts, "user"));
        console.log("Added current user content to finalContents.");
    } else {
        console.log("Current user content has no valid parts.");
    }

    if (finalContents.length === 0) {
      console.warn("No valid content found in input/fileURL or MessageHistory to send to Gemini.");
      return new Response(JSON.stringify({
        success: false,
        response: "没有找到有效内容发送给Gemini。",
        fileDatas: []
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // --- 3. 调用 Gemini API ---
    console.log("Final contents sending to Gemini:", JSON.stringify(finalContents, null, 2));

    const generationConfig: any = {
      // temperature 只有在明确提供且为 number 时才加入
      ...(temperature !== undefined && { temperature: temperature }), 
    };

    const safetySettings: any[] = []; // 根据需要添加安全设置

    const requestOptions: any = {
        model: modelName, // 使用动态模型名称
        contents: finalContents,
        generationConfig: Object.keys(generationConfig).length > 0 ? generationConfig : undefined, // 如果为空对象则不传入
        safetySettings: safetySettings.length > 0 ? safetySettings : undefined, // 如果为空数组则不传入
        systemInstruction: systemInstruction // 加入 systemInstruction
    };

    const geminiResponse = await ai.models.generateContent(requestOptions);

    const generatedText = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log(`Gemini generated text: ${generatedText.substring(0, Math.min(generatedText.length, 100))}...`);

    // --- 4. 返回结果 ---
    return new Response(JSON.stringify({
      success: true,
      response: generatedText,
      fileDatas: newlyUploadedFilesInfo
    }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error in handleJsonRequest:", error);
    return new Response(JSON.stringify({
      success: false,
      response: `内部服务器错误: ${error.message || "未知错误"}`,
      fileDatas: [],
      details: error.stack
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// 全局请求处理函数 (serve 监听器)
serve(async (req) => {
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
      console.log("Received JSON data from Coze tool (Deno handler):", JSON.stringify(data, null, 2));
      return await handleJsonRequest(data);
    } else {
      return new Response(JSON.stringify({ error: "Unsupported Content-Type. Please use application/json." }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  } catch (error: any) {
    console.error("Error processing request in global handler:", error);
    return new Response(JSON.stringify({
      success: false,
      response: `请求处理失败: ${error.message || "未知错误"}`,
      fileDatas: [],
      details: error.stack
    }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
});
