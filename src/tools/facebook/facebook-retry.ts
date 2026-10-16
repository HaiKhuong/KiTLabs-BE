const RETRYABLE_GRAPH_CODES = new Set([1, 2, 4, 17, 32, 613]);
const PERMISSION_GRAPH_CODES = new Set([10, 102, 190, 200]);

export type FailureClass = {
  retryable: boolean;
  uncertain: boolean;
  permission: boolean;
  code: string;
};

export function classifyFacebookFailure(input: {
  hasResponse: boolean;
  httpStatus?: number;
  graphCode?: number;
}): FailureClass {
  const code = input.graphCode != null ? String(input.graphCode) : input.httpStatus ? `HTTP_${input.httpStatus}` : "NETWORK";
  if (input.graphCode != null && PERMISSION_GRAPH_CODES.has(input.graphCode)) {
    return { retryable: false, uncertain: false, permission: true, code };
  }
  if (!input.hasResponse) {
    return { retryable: false, uncertain: true, permission: false, code };
  }
  if (input.graphCode != null && RETRYABLE_GRAPH_CODES.has(input.graphCode)) {
    return { retryable: true, uncertain: false, permission: false, code };
  }
  if (input.httpStatus === 429) {
    return { retryable: true, uncertain: false, permission: false, code: "HTTP_429" };
  }
  if (input.httpStatus != null && input.httpStatus >= 500) {
    return { retryable: false, uncertain: true, permission: false, code };
  }
  return { retryable: false, uncertain: false, permission: false, code };
}
