import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db/client.js";
import { askFinancialAssistant } from "../services/ai-query.service.js";
import {
  executeFinancialMcpTool,
  listFinancialMcpTools,
} from "../services/mcp-finance.service.js";
import { getSettings } from "../services/settings.service.js";

const askSchema = z.object({
  prompt: z.string().trim().min(1, "Please enter a question.").max(500),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD format.").optional(),
});

const mcpCallSchema = z.object({
  tool: z.string().min(1),
  arguments: z.record(z.string(), z.any()).default({}),
});

export function aiRoutes(db: AppDb): Router {
  const router = Router();

  /**
   * Ask natural-language questions to the zero-knowledge financial assistant.
   * e.g. "show me my top spending category in the past 2 weeks"
   */
  router.post("/ai/ask", async (req, res, next) => {
    try {
      const { prompt, today } = askSchema.parse(req.body);
      const result = await askFinancialAssistant(db, prompt, { today });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Status of the AI engine, whether Gemini API key is configured, and privacy guarantees.
   */
  router.get("/ai/status", (_req, res) => {
    const settings = getSettings(db);
    const hasGeminiKey = Boolean(settings.geminiApiKey && settings.geminiApiKey.trim().length > 0);

    res.json({
      configured: true,
      hasGeminiKey,
      model: hasGeminiKey ? "gemini-2.5-flash" : "local-semantic-planner (offline)",
      zeroDataGuarantee: true,
      privacyGuarantee:
        "No personal financial records, transaction details, or account numbers are ever sent to the model.",
      suggestions: [
        "Show me my top spending category in the past 2 weeks",
        "What is my cash forecast for the next 60 days?",
        "How is my monthly budget tracking?",
        "What recurring subscriptions am I paying for?",
        "Show my net worth trend over the last 6 months",
      ],
    });
  });

  /**
   * MCP Tool discovery endpoint.
   */
  router.get("/ai/mcp/tools", (_req, res) => {
    res.json({
      tools: listFinancialMcpTools(),
    });
  });

  /**
   * MCP Tool execution endpoint.
   */
  router.post("/ai/mcp/call", async (req, res, next) => {
    try {
      const { tool, arguments: args } = mcpCallSchema.parse(req.body);
      const result = await executeFinancialMcpTool(db, tool, args);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
