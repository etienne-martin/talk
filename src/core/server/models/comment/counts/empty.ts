import { GQLCOMMENT_STATUS } from "coral-server/graph/schema/__generated__/types";

import {
  CommentModerationCountsPerQueue,
  CommentModerationQueueCounts,
  CommentStatusCounts,
  RelatedCommentCounts,
} from "./counts";

export function createEmptyCommentModerationCountsPerQueue(): CommentModerationCountsPerQueue {
  return {
    unmoderated: 0,
    reported: 0,
    pending: 0,
  };
}

export function createEmptyCommentModerationQueueCounts(): CommentModerationQueueCounts {
  return {
    total: 0,
    queues: createEmptyCommentModerationCountsPerQueue(),
  };
}

export function createEmptyCommentStatusCounts(): CommentStatusCounts {
  return {
    [GQLCOMMENT_STATUS.APPROVED]: 0,
    [GQLCOMMENT_STATUS.NONE]: 0,
    [GQLCOMMENT_STATUS.PREMOD]: 0,
    [GQLCOMMENT_STATUS.REJECTED]: 0,
    [GQLCOMMENT_STATUS.SYSTEM_WITHHELD]: 0,
  };
}

export function createEmptyRelatedCommentCounts(): RelatedCommentCounts {
  return {
    action: {},
    status: createEmptyCommentStatusCounts(),
    moderationQueue: createEmptyCommentModerationQueueCounts(),
  };
}
