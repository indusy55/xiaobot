import { ChatTask } from "./chat-task.js";
import type { TaskDependencies, TaskRecord } from "./types.js";

export function createTask(task: TaskRecord, dependencies: TaskDependencies) {
  switch (task.type) {
    case "chat":
      return new ChatTask(task, dependencies);
    default:
      throw new Error(`Unsupported task type: ${task.type}`);
  }
}
