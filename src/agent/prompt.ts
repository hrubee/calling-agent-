import type { Agent } from "../store/types";

export const TRANSFER_TOKEN = "[[TRANSFER]]";

/** Build the system prompt for a call from the agent's persona + voice constraints. */
export function buildSystemPrompt(agent: Agent): string {
  const langLine =
    agent.language === "auto"
      ? "Detect the language and script the caller is using and always reply in that same language."
      : `Always reply in ${agent.language}.`;

  const lines = [
    agent.systemPrompt.trim(),
    "",
    "You are speaking on a live phone call. Keep replies short and conversational — usually one or two sentences.",
    "Do not use markdown, bullet points, emojis, headings, or code blocks. Your reply is read aloud by a text-to-speech engine, so write plain spoken sentences and spell out anything hard to pronounce.",
    langLine,
  ];

  if (agent.transferNumber && agent.transferNumber.trim()) {
    lines.push(
      `If the caller asks to speak to a human, or you cannot help them, say one short handoff sentence and then put the exact token ${TRANSFER_TOKEN} at the very end of your reply.`,
    );
  }

  return lines.join("\n");
}
