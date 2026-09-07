import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  removeTaskAttachment,
  openTaskAttachment,
  revealTaskAttachment,
  startTaskAttachmentDrag,
} from "../lib/tauri";
import type { CreateTaskInput, Task, TaskStatus, UpdateTaskPatch } from "../types";

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["tasks-count"] });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateTaskPatch }) => updateTask(id, patch),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["tasks-count"] });
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["tasks-count"] });
      queryClient.invalidateQueries({ queryKey: ["tasks-for-mail"] });
    },
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
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(["tasks", "all"], context.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["tasks-count"] });
    },
  });
}

export function useChecklist(taskId: string | null) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };
  const addItem = useMutation({
    mutationFn: (text: string) => addChecklistItem(taskId!, text),
    onSuccess: invalidate,
  });
  const updateItem = useMutation({
    mutationFn: ({ id, text, done }: { id: string; text?: string; done?: boolean }) => updateChecklistItem(id, text, done),
    onSuccess: invalidate,
  });
  const deleteItem = useMutation({
    mutationFn: (id: string) => deleteChecklistItem(id),
    onSuccess: invalidate,
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderChecklist(taskId!, ids),
    onSuccess: invalidate,
  });
  return { addItem, updateItem, deleteItem, reorder };
}

export function useTaskLinks(taskId: string | null) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
    queryClient.invalidateQueries({ queryKey: ["tasks-for-mail"] });
  };
  const link = useMutation({
    mutationFn: (mailId: string) => linkTaskMail(taskId!, mailId),
    onSuccess: invalidate,
  });
  const unlink = useMutation({
    mutationFn: (mailId: string) => unlinkTaskMail(taskId!, mailId),
    onSuccess: invalidate,
  });
  return { link, unlink };
}

export function useTaskAttachments(taskId: string | null) {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };
  const add = useMutation({
    mutationFn: () => addTaskAttachments(taskId!),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeTaskAttachment(id),
    onSuccess: invalidate,
  });
  const open = useMutation({
    mutationFn: (id: string) => openTaskAttachment(id),
  });
  const reveal = useMutation({
    mutationFn: (id: string) => revealTaskAttachment(id),
  });
  const startDrag = useMutation({
    mutationFn: (id: string) => startTaskAttachmentDrag(id),
  });
  return { add, remove, open, reveal, startDrag };
}
