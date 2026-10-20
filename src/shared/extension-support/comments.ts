import type { AreaSupport } from "./types.ts";

/** Support table changes of the "comments" area. */
export const commentsSupport: AreaSupport = {
  api: {
    "comments.*": null,
    "comments.createCommentController": "supported",
  },
  types: ["CommentMode", "CommentState", "CommentThreadCollapsibleState", "CommentThreadState", "CommentThreadApplicability"],
};
