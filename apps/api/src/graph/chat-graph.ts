import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

export type ChatTurn = { role: "user" | "assistant"; content: string };

export interface ChatModel {
  generate(history: ChatTurn[], message: string): Promise<string>;
}

export const echoModel: ChatModel = {
  generate: async (_history, message) =>
    `Snowfall a reçu ton message : ${message}`,
};

const ChatState = Annotation.Root({
  message: Annotation<string>,
  history: Annotation<ChatTurn[]>,
  response: Annotation<string>,
});

export function buildChatGraph(model: ChatModel = echoModel) {
  return new StateGraph(ChatState)
    .addNode("generate", async (state) => ({
      response: await model.generate(state.history, state.message),
    }))
    .addEdge(START, "generate")
    .addEdge("generate", END)
    .compile();
}

const defaultGraph = buildChatGraph();

export async function runChatGraph(
  input: { message: string; history?: ChatTurn[] },
  graph: ReturnType<typeof buildChatGraph> = defaultGraph,
): Promise<string> {
  const result = await graph.invoke({
    message: input.message,
    history: input.history ?? [],
    response: "",
  });
  return result.response;
}