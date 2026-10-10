import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

const ChatState = Annotation.Root({
  message: Annotation<string>,
  response: Annotation<string>,
});

const processMessage = async (state: typeof ChatState.State) => {
  return {
    response: `Snowfall a reçu ton message : ${state.message}`,
  };
};

const graph = new StateGraph(ChatState)
  .addNode("processMessage", processMessage)
  .addEdge(START, "processMessage")
  .addEdge("processMessage", END)
  .compile();

export async function runChatGraph(message: string): Promise<string> {
  const result = await graph.invoke({
    message,
    response: "",
  });

  return result.response;
}