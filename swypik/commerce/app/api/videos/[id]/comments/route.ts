/**
 * Comentariile unui clip.
 *   GET    ?cursor=&limit=&locale=&focus=         → { pinned, comments, focused, nextCursor, totalCount, viewer }
 *                                                   (`focus` = firul unui comentariu anume, pentru deep link)
 *   GET    ?parent_comment_id=…&cursor=           → răspunsurile unui comentariu
 *   POST   { text, parent_comment_id? }           → comentariu nou (răspunsurile sunt aplatizate la 1 nivel)
 *   DELETE ?comment_id=…                          → autorul sau proprietarul clipului
 * Implementare: lib/social/comments/handlers.ts.
 */
import { getComments, postComment, removeComment } from "@/lib/social/comments/handlers";

export const dynamic = "force-dynamic";

export const GET = getComments;
export const POST = postComment;
export const DELETE = removeComment;
