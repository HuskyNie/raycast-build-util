export const LARGE_RESULT_THRESHOLD = 30_000;
export const LARGE_RESULT_PREVIEW_LENGTH = 4_000;

type BuildFuncDisplayModelOptions = {
  type: string;
  result: string;
};

export type FuncDisplayModel = {
  fileExtension: string;
  fullResult: string;
  isLargeResult: boolean;
  isMultiResult: boolean;
  markdown: string;
  preview: string;
  shouldPrettyPrint: boolean;
  shouldOfferOpenFullResultFile: boolean;
};

export function buildFuncDisplayModel({ type, result }: BuildFuncDisplayModelOptions): FuncDisplayModel {
  const trimmedResult = result.trim();
  const isMultiResult = result.includes("### SM4 Hex");
  const isJsonObjectOrArray = trimmedResult.startsWith("{") || trimmedResult.startsWith("[");
  const isLargeResult = result.length > LARGE_RESULT_THRESHOLD;

  let renderedResult = result;
  let shouldPrettyPrint = false;

  if (!isMultiResult && isJsonObjectOrArray && !isLargeResult) {
    try {
      renderedResult = JSON.stringify(JSON.parse(result), null, 2);
      shouldPrettyPrint = true;
    } catch {
      renderedResult = result;
    }
  }

  const preview = (isLargeResult ? result : renderedResult).slice(0, LARGE_RESULT_PREVIEW_LENGTH);
  const fileExtension = isJsonObjectOrArray ? "json" : "txt";

  if (isLargeResult) {
    return {
      fileExtension,
      fullResult: result,
      isLargeResult: true,
      isMultiResult,
      markdown:
        `# ${type}\n\n` +
        `结果过大（${result.length} 字符），已切换为预览模式以避免 UI 卡顿。\n\n` +
        `可使用下方动作复制完整结果或打开临时文件查看全文。\n\n` +
        `预览前 ${preview.length} 字符：\n\n` +
        `\`\`\`\n${preview}\n\`\`\``,
      preview,
      shouldPrettyPrint: false,
      shouldOfferOpenFullResultFile: true,
    };
  }

  return {
    fileExtension,
    fullResult: result,
    isLargeResult: false,
    isMultiResult,
    markdown: `# ${type}\n\n${isMultiResult ? renderedResult : `\`\`\`${shouldPrettyPrint ? "json" : ""}\n${renderedResult}\n\`\`\``}`,
    preview,
    shouldPrettyPrint,
    shouldOfferOpenFullResultFile: true,
  };
}
