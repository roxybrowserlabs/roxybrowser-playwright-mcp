export interface RoutedRequestCall {
  id: string;
  requestId?: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData: string | null;
  postDataBufferBase64?: string | null;
  resourceType?: string;
  isNavigationRequest?: boolean;
}

export type RoutedRequestDecision =
  | {
      action: "abort";
      errorCode?: string;
    }
  | {
      action: "continue";
      headers: Record<string, string>;
      method: string;
      postData: string | null;
      postDataBufferBase64?: string | null;
      response?: RoutedResponseData | null;
      url: string;
    }
  | {
      action: "fulfill";
      body: string;
      bodyBufferBase64?: string | null;
      headers: Record<string, string>;
      status: number;
      statusText: string;
      url: string;
    };

export interface RoutedResponseData {
  body: string;
  bodyBufferBase64?: string | null;
  headers: Record<string, string>;
  status: number;
  statusText: string;
  url: string;
}
