import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { AppError } from "../lib/errors.js";

const decodeBase64 = (value: string): Buffer => {
  const encoded = value.includes(",")
    ? value.slice(value.indexOf(",") + 1)
    : value;
  if (!encoded.trim()) {
    throw new AppError(422, "The uploaded document is empty.");
  }
  try {
    return Buffer.from(encoded.replace(/\s+/g, ""), "base64");
  } catch {
    throw new AppError(422, "The uploaded document is not valid base64 data.");
  }
};

const plainText = (data: Buffer) =>
  data
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\0/g, "")
    .trim();

const rtfText = (data: Buffer) =>
  data
    .toString("latin1")
    .replace(/\\u(-?\d+)\??/g, (_match, code) =>
      String.fromCharCode(
        Number(code) < 0 ? Number(code) + 65536 : Number(code),
      ),
    )
    .replace(/\\'[0-9a-fA-F]{2}/g, (value) =>
      Buffer.from(value.slice(2), "hex").toString("latin1"),
    )
    .replace(/\\(?:par|line)\b/g, "\n")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export async function extractDocumentText(
  documentBase64: string,
  mimeType: string,
  fileName: string,
): Promise<string> {
  const data = decodeBase64(documentBase64);
  const mime = mimeType.trim().toLowerCase();
  const suffix = fileName.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  let extracted = "";
  if (
    mime.startsWith("text/") ||
    [".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".log"].includes(
      suffix,
    )
  ) {
    extracted = plainText(data);
  } else if (mime === "application/rtf" || suffix === ".rtf") {
    extracted = rtfText(data);
  } else if (mime === "application/pdf" || suffix === ".pdf") {
    try {
      extracted = (await pdfParse(data)).text.trim();
    } catch {
      throw new AppError(422, "The PDF could not be read for meal analysis.");
    }
  } else if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    suffix === ".docx"
  ) {
    try {
      extracted = (await mammoth.extractRawText({ buffer: data })).value.trim();
    } catch {
      throw new AppError(
        422,
        "The DOCX file could not be read for meal analysis.",
      );
    }
  } else if (mime.startsWith("application/msword") || suffix === ".doc") {
    throw new AppError(
      422,
      "Legacy .doc files are not supported yet. Save the file as .docx, .pdf, or .txt and try again.",
    );
  } else {
    extracted = plainText(data);
  }
  if (!extracted) {
    throw new AppError(
      422,
      "The uploaded document did not contain readable meal text.",
    );
  }
  return extracted.slice(0, 200_000);
}
