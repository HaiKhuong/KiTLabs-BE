import { NotificationType } from "../../common/enums/domain.enums";

/**
 * Chuyển lỗi kỹ thuật thành thông báo người dùng đọc được.
 * Không lộ stack trace, đường dẫn máy chủ, hay exception hệ thống thô.
 */
export function toPublicErrorMessage(raw: unknown, fallback?: string): string {
  const defaultMsg = fallback ?? "Đã xảy ra lỗi khi xử lý. Vui lòng thử lại.";
  const text = String(raw ?? "")
    .replace(/\r/g, "")
    .trim();
  if (!text) return defaultMsg;

  const firstUsefulLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .find(
        (line) =>
          Boolean(line) &&
          !/^at\s+\S+/.test(line) &&
          !/^File\s+"/.test(line) &&
          !/^Traceback/i.test(line) &&
          !/^\^+$/.test(line),
      ) ?? text;

  const candidate = firstUsefulLine.replace(/^Error:\s*/i, "").trim();

  const looksSystem =
    /traceback|exception|nestjs|typeerror|referenceerror|syntaxerror|econnrefused|enotfound|etimedout|econnreset|socket hang up|errno|enoent|eacces|eperm|segfault|out of memory|\boom\b|cuda|cudnn|nvml|libcudart|ffmpeg.*(error|failed)|spawn\s+\w+\s+enoent|cannot find module|module not found|internal server error|prisma|typeorm|queryfailederror|violates\s|sqlstate|unrecoverableerror|worker\s+exited|killed|sigkill|sigterm|heap out of memory|maxlisteners|dep\d+:|node:internal|\.ts:\d+|\.js:\d+|\/home\/|\/var\/|\/usr\/|\\users\\|process\.cwd|stack:/i.test(
      candidate,
    ) ||
    candidate.includes("    at ") ||
    /^[A-Za-z]+Error:/.test(candidate);

  if (looksSystem) {
    if (/econnrefused|etimedout|econnreset|socket hang up|enotfound/i.test(text)) {
      return "Không kết nối được dịch vụ xử lý. Vui lòng thử lại sau.";
    }
    if (/enoent|no such file|cannot find/i.test(text)) {
      return "Thiếu file hoặc dữ liệu cần thiết để xử lý. Kiểm tra lại nguồn và thử lại.";
    }
    if (/eacces|eperm|permission denied/i.test(text)) {
      return "Hệ thống không có quyền ghi/đọc file tạm. Vui lòng thử lại sau.";
    }
    if (/cuda|cudnn|nvml|out of memory|\boom\b|heap out of memory/i.test(text)) {
      return "Hết tài nguyên xử lý (GPU/bộ nhớ). Thử lại sau hoặc giảm độ dài nội dung.";
    }
    if (/ffmpeg/i.test(text)) {
      return "Xử lý video/audio thất bại. Kiểm tra file nguồn và thử lại.";
    }
    return defaultMsg;
  }

  // BadRequest / message nghiệp vụ sạch — giữ chi tiết (giới hạn dài).
  if (candidate.length > 320) {
    return `${candidate.slice(0, 317)}…`;
  }
  return candidate;
}

export function mapNotificationForClient(note: {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
}) {
  return {
    id: note.id,
    userId: note.userId,
    type: note.type,
    title: note.title,
    message: note.message,
    isRead: note.isRead,
    createdAt: toClientIso(note.createdAt),
    updatedAt: toClientIso(note.updatedAt),
  };
}

/**
 * Emit ISO with explicit offset (not forced Z) so FE relative-time không bị lệch timezone.
 * TIMESTAMP without time zone trên PG thường là wall-clock server.
 */
function toClientIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  const pad = (n: number, len = 2) => String(Math.trunc(Math.abs(n))).padStart(len, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
