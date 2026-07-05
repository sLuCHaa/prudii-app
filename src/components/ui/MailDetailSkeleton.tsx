import { Skeleton, SkeletonCircle, SkeletonText } from "./Skeleton";

export function MailDetailSkeleton() {
  return (
    <div className="flex-1 flex flex-col h-full bg-bg overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-border">
        {/* Subject */}
        <Skeleton width="70%" height="1.125rem" rounded="md" className="mb-3" />

        {/* Sender Info */}
        <div className="flex items-center gap-2.5 mb-3">
          <SkeletonCircle size="32px" />
          <div className="flex-1 min-w-0">
            <Skeleton width="150px" height="0.875rem" rounded="sm" className="mb-1" />
            <Skeleton width="200px" height="0.75rem" rounded="sm" />
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2">
          <Skeleton width="32px" height="32px" rounded="md" />
          <Skeleton width="32px" height="32px" rounded="md" />
          <Skeleton width="32px" height="32px" rounded="md" />
          <div className="flex-1" />
          <Skeleton width="32px" height="32px" rounded="md" />
          <Skeleton width="32px" height="32px" rounded="md" />
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden p-6">
        <div className="space-y-3">
          <SkeletonText lines={3} />
          <div className="h-4" />
          <SkeletonText lines={4} />
          <div className="h-4" />
          <SkeletonText lines={2} />
        </div>
      </div>
    </div>
  );
}
