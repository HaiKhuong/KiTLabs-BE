import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppConfigService } from "../../common/config/app-config.service";
import { GoogleGenAI } from "@google/genai";
import { resolveLiveGeminiKeys } from "../../common/gemini/gemini-key-pools";

export interface ParsedGeminiData {
  summary?: string;
  headers?: string[];
  rows: (string | number | boolean)[][];
  rawText: string;
}

const DEFAULT_EXTRACT_PROMPT = `Bạn là một chuyên gia bóc tách dữ liệu từ văn bản hành chính (OCR Data Extraction Specialist). 
Hãy phân tích toàn bộ các hình ảnh "Training Attendance Record" được cung cấp (từ hình ảnh đầu tiên đến hình ảnh cuối cùng theo đúng thứ tự) và trích xuất toàn bộ thông tin theo đúng cấu trúc JSON dưới đây.

Yêu cầu cụ thể cho từng tờ phiếu:
1. Thông tin chung (Header):
   - "Date": Đọc giá trị ngày tháng năm tại mục "Date" (Ví dụ: "21-Oct-26"). Nếu để trống, trả về chuỗi rỗng "".
   - "Duration": Đọc giá trị thời lượng tại mục "Duration (Min)" (Ví dụ: "30 mins").
   - "Trainer": Đọc tên người huấn luyện tại mục "Trainer". Nếu để trống, trả về "".
   - "Venue": Đọc địa điểm tại mục "Venue" (Ví dụ: "Office").

2. Danh sách tham dự (Table):
   - Trích xuất toàn bộ các dòng trong bảng danh sách thành một mảng (array) gồm các đối tượng có cấu trúc:
     - "No": Số thứ tự (kiểu số hoặc chuỗi).
     - "Full name": Họ và tên đầy đủ của nhân viên.
     - "Position": Chức vụ của nhân viên (Ví dụ: "SENIOR SUPERVISOR", "TECHNICIAN", "CARPENTER", "PAINTER"...). Nếu ô trống trả về "".
     - "Signature": Kiểm tra xem ô chữ ký có chữ ký tay hay không. Trả về giá trị "Signed" (Đã ký) nếu có nét chữ ký, hoặc "Unsigned" (Chưa ký) nếu ô trống.
     - "Remark": Ghi chú (nếu có). Nếu trống, trả về "".
   - Bỏ qua các dòng trống hoàn toàn không có dữ liệu nhân viên.

Hãy gộp kết quả của tất cả các ảnh vào một mảng \`sheets\`, trong đó mỗi phần tử đại diện cho một tờ phiếu kèm theo \`sheet_index\` (thứ tự tờ phiếu tương ứng với ảnh truyền vào).

Hãy chỉ trả về duy nhất một đối tượng định dạng JSON hợp lệ (valid JSON), không kèm theo bất kỳ văn bản giải thích nào khác ngoài JSON.

Cấu trúc JSON mẫu mong muốn:
{
  "sheets": [
    {
      "sheet_index": 1,
      "header": {
        "Date": "21-Oct-26",
        "Duration": "30 mins",
        "Trainer": "",
        "Venue": "Office"
      },
      "attendance_list": [
        {
          "No": 1,
          "Full name": "NGUYỄN MINH ĐỨC",
          "Position": "SENIOR SUPERVISOR",
          "Signature": "Signed",
          "Remark": ""
        }
      ]
    }
  ]
}`;

@Injectable()
export class TelegramGeminiService {
  private readonly logger = new Logger(TelegramGeminiService.name);
  private readonly defaultModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly appConfig: AppConfigService,
  ) {
    this.defaultModel = this.config.get<string>("TELEGRAM_GEMINI_MODEL") || "gemini-2.5-flash";
  }

  /**
   * Lấy API Key thích hợp (ưu tiên key của user, fallback sang system pool)
   */
  resolveApiKey(userApiKey?: string): string {
    // 1. Thử từ appConfig secret cache (Key Vault Cấu hình Runtime của toàn hệ thống)
    const appSecret = this.appConfig.getSecret("GEMINI_API_KEY") || this.appConfig.getSecret("GEMINI_API_KEY_VIP");
    if (appSecret?.trim()) {
      const first = appSecret.trim().split(/[,;\s]+/)[0].trim();
      if (first) return first;
    }

    // 2. Thử từ pool toàn hệ thống (resolveLiveGeminiKeys)
    const liveKeys = resolveLiveGeminiKeys(this.config);
    if (liveKeys.length > 0 && liveKeys[0]) {
      return liveKeys[0];
    }

    // 3. Thử từ biến môi trường toàn hệ thống
    const envKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_VIP || process.env.GOOGLE_API_KEY;
    if (envKey?.trim()) {
      const first = envKey.trim().split(/[,;\s]+/)[0].trim();
      if (first) return first;
    }

    // 4. Fallback: Key riêng do user cài đặt qua Telegram (nếu có)
    if (userApiKey?.trim()) {
      return userApiKey.trim();
    }

    throw new BadRequestException(
      "Hệ thống chưa cấu hình Gemini API Key. Vui lòng cài đặt key bằng lệnh /gemini_key trên Telegram hoặc vào Cài đặt → Cấu hình runtime → Gemini Key Vault.",
    );
  }

  /**
   * Gọi Gemini Vision với danh sách nhiều hình ảnh và prompt (Xử lý nhiều ảnh trong 1 request)
   */
  async extractDataFromImages(options: {
    images: Array<{ buffer: Buffer; mimeType?: string }>;
    customPrompt?: string;
    caption?: string;
    userApiKey?: string;
    model?: string;
  }): Promise<ParsedGeminiData> {
    if (!options.images || options.images.length === 0) {
      throw new BadRequestException("Không có hình ảnh nào được cung cấp để phân tích.");
    }

    const apiKey = this.resolveApiKey(options.userApiKey);
    const modelName = options.model || this.defaultModel;

    // Xây dựng Prompt
    let promptText = options.customPrompt?.trim() ? options.customPrompt.trim() : DEFAULT_EXTRACT_PROMPT;
    if (options.caption?.trim()) {
      promptText += `\n\nGHI CHÚ BỔ SUNG TỪ NGƯỜI DÙNG CHO CÁC ẢNH NÀY:\n${options.caption.trim()}`;
    }

    try {
      const ai = new GoogleGenAI({ apiKey });

      const parts: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }> = options.images.map(
        (img) => ({
          inlineData: {
            mimeType: img.mimeType || "image/jpeg",
            data: img.buffer.toString("base64"),
          },
        }),
      );
      parts.push({ text: promptText });

      this.logger.log(`[Gemini Vision] Đang gửi ${options.images.length} ảnh trong 1 request lên model ${modelName}...`);

      const response = await ai.models.generateContent({
        model: modelName,
        contents: [
          {
            role: "user",
            parts,
          },
        ],
      });

      let rawText = "";
      const resAny = response as unknown as {
        text?: string | (() => string);
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };

      if (typeof resAny.text === "function") {
        rawText = resAny.text();
      } else if (typeof resAny.text === "string") {
        rawText = resAny.text;
      } else if (resAny.candidates?.[0]?.content?.parts?.[0]?.text) {
        rawText = resAny.candidates[0].content.parts[0].text;
      }

      if (!rawText.trim()) {
        throw new BadRequestException("Gemini không trả về nội dung nhận diện từ các hình ảnh này.");
      }

      return this.parseGeminiOutput(rawText);
    } catch (err: unknown) {
      this.logger.error(`Error calling Gemini Vision: ${(err as Error)?.message}`, (err as Error)?.stack);
      throw new BadRequestException(`Lỗi phân tích hình ảnh bằng Gemini: ${(err as Error)?.message || String(err)}`);
    }
  }

  /**
   * Gọi Gemini Vision với 1 hình ảnh duy nhất (giữ tương thích)
   */
  async extractDataFromImage(options: {
    imageBuffer: Buffer;
    mimeType?: string;
    customPrompt?: string;
    caption?: string;
    userApiKey?: string;
    model?: string;
  }): Promise<ParsedGeminiData> {
    return this.extractDataFromImages({
      images: [{ buffer: options.imageBuffer, mimeType: options.mimeType }],
      customPrompt: options.customPrompt,
      caption: options.caption,
      userApiKey: options.userApiKey,
      model: options.model,
    });
  }

  /**
   * Phân tích an toàn chuỗi trả về từ Gemini thành mảng dòng cho Google Sheets
   */
  parseGeminiOutput(rawText: string): ParsedGeminiData {
    const cleaned = rawText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .trim();

    try {
      const parsed = JSON.parse(cleaned) as unknown;

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;

        // Dạng 1: Cấu trúc Training Attendance Record { sheets: [ { sheet_index, header, attendance_list } ] }
        if (Array.isArray(obj.sheets)) {
          const sheetsArr = obj.sheets as Array<{
            sheet_index?: number;
            header?: {
              Date?: string;
              Duration?: string;
              Trainer?: string;
              Venue?: string;
            };
            attendance_list?: Array<{
              No?: number | string;
              "Full name"?: string;
              FullName?: string;
              Position?: string;
              Signature?: string;
              Remark?: string;
            }>;
          }>;

          const headers = [
            "Sheet",
            "Date",
            "Duration",
            "Trainer",
            "Venue",
            "No",
            "Full name",
            "Position",
            "Signature",
            "Remark",
          ];

          const rows: (string | number | boolean)[][] = [];
          let totalAttendees = 0;
          const dates: string[] = [];

          for (const sheet of sheetsArr) {
            const sheetIdx = sheet.sheet_index ?? 1;
            const h = sheet.header || {};
            const date = h.Date ?? "";
            const duration = h.Duration ?? "";
            const trainer = h.Trainer ?? "";
            const venue = h.Venue ?? "";
            if (date && !dates.includes(date)) dates.push(date);

            const list = Array.isArray(sheet.attendance_list) ? sheet.attendance_list : [];
            if (list.length === 0) {
              rows.push([sheetIdx, date, duration, trainer, venue, "", "", "", "", ""]);
            } else {
              for (const item of list) {
                totalAttendees++;
                rows.push([
                  sheetIdx,
                  date,
                  duration,
                  trainer,
                  venue,
                  item.No ?? "",
                  item["Full name"] ?? item.FullName ?? "",
                  item.Position ?? "",
                  item.Signature ?? "",
                  item.Remark ?? "",
                ]);
              }
            }
          }

          const summary = `Training Attendance: ${totalAttendees} nhân sự (${sheetsArr.length} phiếu${dates.length ? `, Ngày: ${dates.join(", ")}` : ""})`;
          return { summary, headers, rows, rawText };
        }

        // Dạng 1b: Trường hợp trả về 1 sheet đơn lẻ { header, attendance_list }
        if (obj.header && Array.isArray(obj.attendance_list)) {
          const h = (obj.header || {}) as Record<string, string>;
          const date = h.Date ?? "";
          const duration = h.Duration ?? "";
          const trainer = h.Trainer ?? "";
          const venue = h.Venue ?? "";

          const headers = [
            "Date",
            "Duration",
            "Trainer",
            "Venue",
            "No",
            "Full name",
            "Position",
            "Signature",
            "Remark",
          ];

          const list = obj.attendance_list as Array<Record<string, unknown>>;
          const rows = list.map((item) => [
            date,
            duration,
            trainer,
            venue,
            (item.No as string | number) ?? "",
            (item["Full name"] || item.FullName || "") as string,
            (item.Position || "") as string,
            (item.Signature || "") as string,
            (item.Remark || "") as string,
          ]);

          const summary = `Training Attendance: ${rows.length} nhân sự (Ngày: ${date || "N/A"})`;
          return { summary, headers, rows, rawText };
        }

        // Dạng 1c: Đối tượng chuẩn { summary, headers, rows }
        const summary = typeof obj.summary === "string" ? obj.summary : undefined;
        let headers: string[] | undefined = undefined;
        if (Array.isArray(obj.headers)) {
          headers = obj.headers.map((h) => String(h ?? ""));
        }

        let rows: (string | number | boolean)[][] = [];
        if (Array.isArray(obj.rows)) {
          rows = obj.rows.map((row) => {
            if (Array.isArray(row)) {
              return row.map((cell) => (cell === null || cell === undefined ? "" : (cell as string | number | boolean)));
            }
            if (row && typeof row === "object") {
              return Object.values(row).map((v) => (v === null || v === undefined ? "" : (v as string | number | boolean)));
            }
            return [String(row ?? "")];
          });
        }

        if (rows.length > 0) {
          return { summary, headers, rows, rawText };
        }
      }

      // Dạng 2: Mảng 2 chiều trực tiếp [ ["Col1", "Col2"], ["Val1", "Val2"] ]
      if (Array.isArray(parsed) && parsed.length > 0) {
        if (Array.isArray(parsed[0])) {
          return {
            rows: parsed as (string | number | boolean)[][],
            rawText,
          };
        }

        // Dạng 3: Mảng các object [ { name: "...", price: 100 } ]
        if (typeof parsed[0] === "object" && parsed[0] !== null) {
          const firstObj = parsed[0] as Record<string, unknown>;
          const headers = Object.keys(firstObj);
          const rows = (parsed as Array<Record<string, unknown>>).map((item) =>
            headers.map((k) => (item[k] === null || item[k] === undefined ? "" : (item[k] as string | number | boolean))),
          );
          return { headers, rows, rawText };
        }
      }
    } catch {
      // JSON.parse thất bại, thử trích xuất bằng regex
      const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const fallbackParsed = JSON.parse(jsonMatch[0]) as unknown;
          if (Array.isArray(fallbackParsed)) {
            return {
              rows: fallbackParsed.map((r) => (Array.isArray(r) ? r : [String(r)])),
              rawText,
            };
          }
        } catch {
          // Bỏ qua
        }
      }
    }

    // Fallback: Tách từng dòng văn bản
    const lines = cleaned
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const fallbackRows = lines.map((line) => {
      if (line.includes("\t")) return line.split("\t");
      if (line.includes("|")) return line.split("|").map((c) => c.trim()).filter(Boolean);
      if (line.includes(",")) return line.split(",").map((c) => c.trim());
      return [line];
    });

    return {
      summary: "Dữ liệu văn bản trích xuất",
      rows: fallbackRows.length > 0 ? fallbackRows : [[cleaned]],
      rawText,
    };
  }
}
