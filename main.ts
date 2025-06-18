import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { GoogleGenAI, createUserContent, createPartFromUri } from "npm:@google/genai";

// 配置Google GenAI API
// 请确保将此API_KEY替换为你的实际Gemini API Key
const API_KEY = "AIzaSyAPgNkJpYrO90jKlG4Y3v1jdrAsM2A-_Yc"; // 替换为你的 Gemini API Key
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

    console.log(`Uploading file to Gemini: URL=${url}, MimeType=${mimeType}, Size=${blob.size} bytes`);
    const uploadedFile = await ai.files.upload({
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
          geminiPartsForHistory.push({ text: historyItem.text }); // Gemini content expects { text: "..." }
          console.log(`Added history text for role '${historyItem.role}': ${historyItem.text.substring(0, Math.min(historyItem.text.length, 50))}...`);
        }

        const rawFileData = historyItem.filedata;
        let parsedFileData: any[] = [];

        if (typeof rawFileData === "string" && rawFileData.trim()) {
            try {
                // 尝试解析为 JSON 数组
                parsedFileData = JSON.parse(rawFileData);
                console.log(`Parsed filedata string for role '${historyItem.role}':`, parsedFileData);
            } catch (parseError) {
                console.warn(`Failed to parse filedata string for role '${historyItem.role}' as JSON, treating as empty: ${rawFileData}`, parseError);
                // 如果解析失败，则认为没有有效的文件数据
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

                    // 检查是否是需要上传的Coze链接，或者已经是Gemini的file URI
                    if (!fileUriToUse.startsWith("file://") && !fileUriToUse.startsWith("https://generativelanguage.googleapis.com/v1beta/files/")) {
                        try {
                            const { uploadedFile, mimeType } = await fetchAndUploadFile(fileUriToUse);
                            fileUriToUse = uploadedFile.uri;
                            fileMimeType = mimeType;
                            newlyUploadedFilesInfo.push({ uri: fileUriToUse, mimeType: fileMimeType });
                            console.log(`Uploaded and added new file from history: ${fileUriToUse}`);
                        } catch (uploadError) {
                            console.error(`Failed to upload file from history (${fileUriToUse}):`, uploadError);
                            continue; // 跳过此文件，继续处理下一个
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

        // 只有当有有效内容时才添加到 finalContents
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
      currentUserParts.push({ text: userInput }); // Gemini content expects { text: "..." }
      console.log(`Added current user input text: ${userInput.substring(0, Math.min(userInput.length, 50))}...`);
    } else {
        console.log("Current user input is missing or not a valid string.");
    }

    const userFileURL = data.fileURL; // 这是从 Coze 接收到的 fileURL
    let currentFileURLs: string[] = [];

    // 优先处理数组类型
    if (Array.isArray(userFileURL)) {
        currentFileURLs = userFileURL.filter((url: any) => typeof url === "string" && url.trim());
        console.log(`Received current fileURL as array: ${currentFileURLs.length} items`);
    } 
    // 如果是字符串，尝试解析 JSON 数组，然后回退到逗号分隔或单个 URL
    else if (typeof userFileURL === "string" && userFileURL.trim()) {
        try {
            const parsed = JSON.parse(userFileURL);
            if (Array.isArray(parsed)) {
                // 如果成功解析为数组，则使用解析后的数组
                currentFileURLs = parsed.filter((url: any) => typeof url === "string" && url.trim());
                console.log(`Parsed fileURL string as array: ${currentFileURLs.length} items`);
            } else {
                // 如果解析成功但不是数组 (比如是数字、布尔值或其他非预期类型)，当做单个 URL
                console.warn(`fileURL string parsed to non-array type, treating as single URL: ${userFileURL}`);
                currentFileURLs = [userFileURL.trim()];
                console.log(`Received current fileURL as single string (JSON parsed to non-array): ${currentFileURLs[0]}`);
            }
        } catch (e) {
            // 如果 JSON.parse 失败 (即它不是一个有效的 JSON 字符串，而可能是一个纯 URL 字符串或逗号分隔的 URL 字符串)
            console.warn(`Failed to parse fileURL string as JSON, attempting comma split or single URL: ${userFileURL}`, e);
            if (userFileURL.includes(',')) {
                // 尝试用逗号分隔 (为了兼容旧的或混合格式)
                currentFileURLs = userFileURL.split(',').map((url: string) => url.trim()).filter(Boolean);
                console.log(`Received current fileURL as comma-separated string: ${currentFileURLs.length} items`);
            } else {
                // 如果没有逗号，就当做单个 URL
                currentFileURLs = [userFileURL.trim()];
                console.log(`Received current fileURL as single string (JSON parse failed): ${currentFileURLs[0]}`);
            }
        }
    } else {
        // 如果 fileURL 是 null, undefined, 空字符串或其他非预期类型
        console.log("No valid current fileURL found or it's not an array/string.");
    }

    // 遍历所有当前文件的 URL 进行上传
    for (const url of currentFileURLs) {
        try {
            const { uploadedFile, mimeType } = await fetchAndUploadFile(url);
            newlyUploadedFilesInfo.push({ uri: uploadedFile.uri, mimeType: mimeType });
            currentUserParts.push(createPartFromUri(uploadedFile.uri, mimeType));
            console.log(`Uploaded and added new file from current input: ${url}`);
        } catch (uploadError) {
            console.error(`Failed to upload file from current input (${url}):`, uploadError);
            // 发生错误时，记录日志并继续处理下一个文件，而不是中断整个请求
        }
    }

    if (currentUserParts.length > 0) {
        finalContents.push(createUserContent(currentUserParts, "user"));
        console.log("Added current user content to finalContents.");
    } else {
        console.log("Current user content has no valid parts.");
    }

    // 如果没有任何内容可以发送给 Gemini，则返回错误
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
    const geminiResponse = await ai.models.generateContent({
      model: MODEL,
      contents: finalContents,
    });

    // 提取Gemini的生成文本
    const generatedText = geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log(`Gemini generated text: ${generatedText.substring(0, Math.min(generatedText.length, 100))}...`);

    // --- 4. 返回结果 ---
    return new Response(JSON.stringify({
      success: true,
      response: generatedText,
      fileDatas: newlyUploadedFilesInfo // 返回新上传的文件信息，如果需要
    }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error in handleJsonRequest:", error);
    return new Response(JSON.stringify({
      success: false,
      response: `内部服务器错误: ${error.message || "未知错误"}`,
      fileDatas: [],
      details: error.stack // 包含堆栈信息以便调试
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// 全局请求处理函数 (serve 监听器)
serve(async (req) => {
  const headers = {
    "Access-Control-Allow-Origin": "*", // 允许所有来源
    "Access-Control-Allow-Methods": "POST, OPTIONS", // 允许的HTTP方法
    "Access-Control-Allow-Headers": "Content-Type", // 允许的请求头
  };

  // 处理OPTIONS预检请求
  if (req.method === "OPTIONS") {
    return new Response(null, { headers });
  }

  // 只允许POST请求
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Only POST method is allowed." }), {
      status: 405,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  try {
    const contentType = req.headers.get("Content-Type") || "";

    // 确保请求是 JSON 格式
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
