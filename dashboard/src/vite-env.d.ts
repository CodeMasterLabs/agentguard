/// <reference types="vite/client" />

// WebMCP declarative attributes (https://developer.chrome.com/docs/ai/webmcp): label a form as
// a tool an AI agent can fill in, and describe each of its inputs.
import "react";
declare module "react" {
  interface FormHTMLAttributes<T> {
    toolname?: string;
    tooldescription?: string;
  }
  interface InputHTMLAttributes<T> {
    toolparamdescription?: string;
  }
}
