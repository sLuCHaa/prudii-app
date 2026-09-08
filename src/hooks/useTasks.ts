import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  moveTask,
  countOpenTasks,
  addChecklistItem,
  updateChecklistItem,
  deleteChecklistItem,
  reorderChecklist,
  linkTaskMail,
  unlinkTaskMail,
  addTaskAttachments,
  addTaskAttachmentData,
  removeTaskAttachment,
  openTaskAttachment,
  revealTaskAttachment,
  startTaskAttachmentDrag,
} from "../lib/tauri";
import type { CreateTaskInput, Task, TaskStatus, UpdateTaskPatch } from "../types";
import { useAppStore } from "../stores/appStore";
import i18n from "../lib/i18n";

// Every task mutation can move a card's counts, checklist, links or attachments,
// so all four query families are invalidated together.
export function invalidateTaskQueries(queryClient: QueryClient, taskId?: string | null) {
  queryClient.invalidateQueries({ queryKey: ["tasks"] });
  queryClient.invalidateQueries({ queryKey: taskId ? ["task", taskId] : ["task"] });
  queryClient.invalidateQueries({ queryKey: ["tasks-count"] });
  queryClient.invalidateQueries({ queryKey: ["tasks-for-mail"] });
}

// Task commands report what actually failed (e.g. the files that could not be
// copied), so the backend message is shown below the generic headline.
function onError(err: unknown) {
  useAppStore.getState().addToast("error", i18n.t("errors.generic"), err instanceof Error ? err.message : String(err));
}

function requireTaskId(taskId: string | null): string {
  if (!taskId) throw new Error("taskId required");
  return taskId;
}

export function useTasks(status?: TaskStatus) {
  return useQuery({
    queryKey: ["tasks", status ?? "all"],
    queryFn: () => listTasks(status),
    staleTime: 5_000,
  });
}

export function useTask(id: string | null) {
  return useQuery({
    queryKey: ["task", id],
    queryFn: () => getTask(id!),
    enabled: !!id,
  });
}

export function useOpenTaskCount() {
  return useQuery({
    queryKey: ["tasks-count"],
    queryFn: countOpenTasks,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => createTask(input),
    onSuccess: () => invalidateTaskQueries(queryClient),
    onError,
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateTaskPatch }) => updateTask(id, patch),
    onSuccess: (_data, variables) => invalidateTaskQueries(queryClient, variables.id),
    onError,
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTask(id),
    onSuccess: () => invalidateTaskQueries(queryClient),
    onError,
  });
}

interface MoveTaskVars {
  id: string;
  status: TaskStatus;
  index: number;
}

export function useMoveTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: MoveTaskVars) => moveTask(vars.id, vars.status, vars.index),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["tasks", "all"] });
      const previous = queryClient.getQueryData<Task[]>(["tasks", "all"]);
      if (previous) {
        const moving = previous.find((t) => t.id === vars.id);
        if (moving) {
          const others = previous.filter((t) => t.id !== vars.id);
          const targetColumn = others
            .filter((t) => t.status === vars.status)
            .sort((a, b) => a.sort_order - b.sort_order);
          const restColumns = others.filter((t) => t.status !== vars.status);
          const insertAt = Math.max(0, Math.min(vars.index, targetColumn.length));
          targetColumn.splice(insertAt, 0, { ...moving, status: vars.status });
          const renumbered = targetColumn.map((t, i) => ({ ...t, sort_order: i }));
          queryClient.setQueryData<Task[]>(["tasks", "all"], [...restColumns, ...renumbered]);
        }
      }
      return { previous };
    },
    onError: (err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(["tasks", "all"], context.previous);
      onError(err);
    },
    onSettled: () => invalidateTaskQueries(queryClient),
  });
}

export function useChecklist(taskId: string | null) {
  const queryClient = useQueryClient();
  const invalidate = () => invalidateTaskQueries(queryClient, taskId);
  const addItem = useMutation({
    mutationFn: (text: string) => addChecklistItem(requireTaskId(taskId), text),
    onSuccess: invalidate,
    onError,
  });
  const updateItem = useMutation({
    mutationFn: ({ id, text, done }: { id: string; text?: string; done?: boolean }) => updateChecklistItem(id, text, done),
    onSuccess: invalidate,
    onError,
  });
  const deleteItem = useMutation({
    mutationFn: (id: string) => deleteChecklistItem(id),
    onSuccess: invalidate,
    onError,
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderChecklist(requireTaskId(taskId), ids),
    onSuccess: invalidate,
    onError,
  });
  return { addItem, updateItem, deleteItem, reorder };
}

export function useTaskLinks(taskId: string | null) {
  const queryClient = useQueryClient();
  const invalidate = () => invalidateTaskQueries(queryClient, taskId);
  const link = useMutation({
    mutationFn: (mailId: string) => linkTaskMail(requireTaskId(taskId), mailId),
    onSuccess: invalidate,
    onError,
  });
  const unlink = useMutation({
    mutationFn: (mailId: string) => unlinkTaskMail(requireTaskId(taskId), mailId),
    onSuccess: invalidate,
    onError,
  });
  return { link, unlink };
}

export function useTaskAttachments(taskId: string | null) {
  const queryClient = useQueryClient();
  const invalidate = () => invalidateTaskQueries(queryClient, taskId);
  const add = useMutation({
    mutationFn: () => addTaskAttachments(requireTaskId(taskId)),
    onSuccess: invalidate,
    onError,
  });
  const addData = useMutation({
    mutationFn: ({ filename, dataBase64 }: { filename: string; dataBase64: string }) =>
      addTaskAttachmentData(requireTaskId(taskId), filename, dataBase64),
    onSuccess: invalidate,
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeTaskAttachment(id),
    onSuccess: invalidate,
    onError,
  });
  // `open` is the exception: TaskFiles toasts it with its own, more specific key.
  const open = useMutation({
    mutationFn: (id: string) => openTaskAttachment(id),
  });
  const reveal = useMutation({
    mutationFn: (id: string) => revealTaskAttachment(id),
    onError,
  });
  const startDrag = useMutation({
    mutationFn: (id: string) => startTaskAttachmentDrag(id),
    onError,
  });
  return { add, addData, remove, open, reveal, startDrag };
}
