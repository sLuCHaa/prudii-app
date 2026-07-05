import { Skeleton } from "./Skeleton";

function ViewItemSkeleton() {
  return (
    <div className="px-2 py-1.5">
      <div className="flex items-center gap-2">
        <Skeleton width="16px" height="16px" rounded="sm" />
        <Skeleton width="100px" height="0.875rem" rounded="sm" />
      </div>
    </div>
  );
}

function FolderItemSkeleton() {
  return (
    <div className="px-2 py-1">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-1">
          <Skeleton width="14px" height="14px" rounded="sm" />
          <Skeleton width="80px" height="0.75rem" rounded="sm" />
        </div>
        <Skeleton width="20px" height="0.75rem" rounded="full" />
      </div>
    </div>
  );
}

function AccountSkeleton() {
  return (
    <div className="mb-3">
      {/* Account Header */}
      <div className="px-2 py-2 flex items-center gap-2 mb-1">
        <Skeleton width="16px" height="16px" rounded="sm" />
        <Skeleton width="140px" height="0.875rem" rounded="sm" />
      </div>

      {/* Folders */}
      <div className="space-y-0.5">
        <FolderItemSkeleton />
        <FolderItemSkeleton />
        <FolderItemSkeleton />
        <FolderItemSkeleton />
      </div>
    </div>
  );
}

export function SidebarSkeleton() {
  return (
    <div className="w-64 h-full bg-sidebar border-r border-border flex flex-col">
      {/* Header */}
      <div className="h-14 px-4 flex items-center justify-between border-b border-border shrink-0">
        <Skeleton width="100px" height="1.25rem" rounded="md" />
        <Skeleton width="32px" height="32px" rounded="md" />
      </div>

      <div className="flex-1 overflow-hidden p-2">
        {/* Views Section */}
        <div className="mb-4">
          <div className="px-2 py-1.5 mb-1">
            <Skeleton width="60px" height="0.625rem" rounded="sm" />
          </div>
          <ViewItemSkeleton />
          <ViewItemSkeleton />
          <ViewItemSkeleton />
        </div>

        {/* Accounts Section */}
        <div>
          <div className="px-2 py-1.5 mb-1">
            <Skeleton width="80px" height="0.625rem" rounded="sm" />
          </div>
          <AccountSkeleton />
          <AccountSkeleton />
        </div>
      </div>

      {/* Footer */}
      <div className="h-12 px-4 flex items-center justify-between border-t border-border shrink-0">
        <Skeleton width="32px" height="32px" rounded="full" />
        <Skeleton width="24px" height="24px" rounded="md" />
      </div>
    </div>
  );
}
