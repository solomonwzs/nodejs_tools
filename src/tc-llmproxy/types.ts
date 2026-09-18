import http from "http";

export interface ProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
}

export interface AdamsService {
  name: string;
  id: number;
}

export interface AdamsProxyConfig extends ProxySettings {
  extHeaders?: Record<string, string>;
  baseUrl: string;
  models: AdamsService[];
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface GongfengModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
  headers?: Record<string, string>;
}

export interface GongfengProxyConfig extends ProxySettings {
  baseUrl: string;
  username: string;
  deviceId: string;
  authToken: string;
}

export interface CommonModel {
  id: string;
  [key: string]: unknown;
}

export interface CommonProxyConfig extends ProxySettings {
  name: string;
  baseUrl: string;
  models: CommonModel[];
}

export interface Config {
  listen: number;
  allowLan?: boolean;
  adamsProxy?: AdamsProxyConfig;
  gongfengProxy?: GongfengProxyConfig;
  commProxy?: CommonProxyConfig[];
}

export interface OutboundRequest extends ProxySettings {
  url: string;
  method: string;
  headers: http.OutgoingHttpHeaders;
  body?: Buffer;
}

export interface AdamsPiModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
}

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class DuplicateAdamsModelError extends Error {}
