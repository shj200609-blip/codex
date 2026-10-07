// All wire models come from the fork's generated Rust schema, never duplicated here.
import type { InitializeParams } from "@codex/app-server-protocol/InitializeParams";
import type { InitializeResponse } from "@codex/app-server-protocol/InitializeResponse";
import type { ClientRequest } from "@codex/app-server-protocol/ClientRequest";
import type { ServerNotification } from "@codex/app-server-protocol/ServerNotification";
import type { ChangeSetReadResponse } from "@codex/app-server-protocol/v2/ChangeSetReadResponse";
import type { ChangeSetListResponse } from "@codex/app-server-protocol/v2/ChangeSetListResponse";
import type { ChangeSetReviewResponse } from "@codex/app-server-protocol/v2/ChangeSetReviewResponse";
import type { ChangeSetHunkLocateResponse } from "@codex/app-server-protocol/v2/ChangeSetHunkLocateResponse";
import type { ThreadLoadedListResponse } from "@codex/app-server-protocol/v2/ThreadLoadedListResponse";
import type { ThreadReadResponse } from "@codex/app-server-protocol/v2/ThreadReadResponse";
import type { ThreadResumeResponse } from "@codex/app-server-protocol/v2/ThreadResumeResponse";
import type { ThreadTurnsListResponse } from "@codex/app-server-protocol/v2/ThreadTurnsListResponse";
export type { ChangeSet } from "@codex/app-server-protocol/v2/ChangeSet";
export type { ChangeSetFile } from "@codex/app-server-protocol/v2/ChangeSetFile";
export type { ChangeHunk } from "@codex/app-server-protocol/v2/ChangeHunk";
export type { ChangeReviewState } from "@codex/app-server-protocol/v2/ChangeReviewState";
export type { ChangeSetReviewParams } from "@codex/app-server-protocol/v2/ChangeSetReviewParams";
export type { ChangeSetHunkResult } from "@codex/app-server-protocol/v2/ChangeSetHunkResult";
export type { HunkLocationResult } from "@codex/app-server-protocol/v2/HunkLocationResult";
export type {
  ChangeSetReadResponse,
  ChangeSetReviewResponse,
  ChangeSetHunkLocateResponse,
  InitializeParams,
};

export type ReviewMethod =
  | "changeSet/hunk/accept"
  | "changeSet/hunk/revert"
  | "changeSet/file/accept"
  | "changeSet/file/revert"
  | "changeSet/accept"
  | "changeSet/revert";
export type Responses = {
  initialize: InitializeResponse;
  "changeSet/read": ChangeSetReadResponse;
  "changeSet/list": ChangeSetListResponse;
  "changeSet/hunk/locate": ChangeSetHunkLocateResponse;
  "thread/loaded/list": ThreadLoadedListResponse;
  "thread/read": ThreadReadResponse;
  "thread/resume": ThreadResumeResponse;
  "thread/turns/list": ThreadTurnsListResponse;
} & Record<ReviewMethod, ChangeSetReviewResponse>;
export type Method = keyof Responses;
export type Params<M extends Method> = M extends "initialize"
  ? InitializeParams
  : Extract<ClientRequest, { method: M }>["params"];
export type NotificationMethod = ServerNotification["method"];
export type NotificationParams<M extends NotificationMethod> = Extract<
  ServerNotification,
  { method: M }
>["params"];
export interface RpcClient {
  request<M extends Method>(
    method: M,
    params: Params<M>,
  ): Promise<Responses[M]>;
  onNotification<M extends NotificationMethod>(
    method: M,
    listener: (params: NotificationParams<M>) => void,
  ): () => void;
}
