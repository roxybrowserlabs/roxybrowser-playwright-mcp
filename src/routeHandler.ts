import type { URLMatch } from "./urlMatch.js";
import type { Request, Route } from "./types/api.js";

export type RouteMatcher = URLMatch;

export interface RouteHandlerInvocation {
  complete: Promise<void>;
  resolve: () => void;
}

export interface RouteHandlerEntry {
  matcher: RouteMatcher;
  handler: (route: Route, request: Request) => Promise<any> | any;
  activeInvocations: Set<RouteHandlerInvocation>;
  ignoreExceptions: boolean;
  remainingTimes: number | null;
}
