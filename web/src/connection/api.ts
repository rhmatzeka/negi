// Server calls as TanStack Query mutations, so every caller gets pending and error state.
import { useApp } from "@/lib/store";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { request, signIn } from "@/connection/link";

/** A request over the socket. A refusal is shown as a toast, so no caller forgets to. */
export function useAsk() {
  return useMutation({
    mutationFn: (message: object) => request(message),
    onError: (error) => toast.error(error.message),
  });
}

/** Trades a pairing code for a device token. */
export function usePair() {
  return useMutation({
    mutationFn: async (input: { code: string; label: string }) => {
      let response: Response;
      try {
        response = await fetch("/api/pair", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
      } catch {
        throw new Error("Could not reach your Mac.");
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `The Mac answered ${response.status}`);
      return body.token as string;
    },
    onSuccess: signIn,
  });
}

/** Sends a file to the host, which keeps it and answers with the path it has there. */
export async function upload(file: File): Promise<string> {
  const token = useApp.getState().token;
  if (!token) throw new Error("This device is not paired");
  const response = await fetch("/api/upload", {
    method: "POST",
    // The name travels in a header, so it has to be plain ASCII; the host cleans it further.
    headers: { Authorization: `Bearer ${token}`, "X-Name": file.name.replace(/[^\x20-\x7e]/g, "-") },
    body: file,
  });
  const body = (await response.json().catch(() => ({}))) as { path?: string; error?: string };
  if (!response.ok || !body.path) throw new Error(body.error ?? (response.status === 413 ? "That file is larger than 32 MB" : "The file could not be sent"));
  return body.path;
}
