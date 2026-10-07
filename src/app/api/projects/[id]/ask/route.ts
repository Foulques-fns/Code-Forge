import { answerQuestion } from "@/lib/ai/engine";
import { getProjectFiles, addMessage } from "@/lib/forge/store";
import { VFS, buildIndex } from "@/lib/forge/vfs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

/** Project Q&A: answers from the REAL file index + relevant excerpts. */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: { question?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "JSON invalide." }, { status: 400 });
  }
  const question = (body.question ?? "").trim();
  if (question.length < 3 || question.length > 2000) {
    return Response.json({ error: "Question vide ou trop longue." }, { status: 400 });
  }
  const files = await getProjectFiles(id);
  if (!files.length) return Response.json({ error: "Le projet est vide — rien à analyser pour l'instant." }, { status: 400 });

  const vfs = VFS.from(files.map((f) => ({ path: f.path, content: f.content })));
  const index = buildIndex(vfs);

  // Simple relevance sampling: files mentioning question words first
  const words = new Set(question.toLowerCase().split(/[^a-zà-öø-ÿ0-9_]+/i).filter((w) => w.length > 3));
  const samples = vfs
    .paths()
    .map((p) => {
      const c = vfs.read(p)!;
      const hay = (p + "\n" + c).toLowerCase();
      let s = 0;
      for (const w of words) if (hay.includes(w)) s++;
      return { path: p, content: c, s };
    })
    .sort((a, b) => b.s - a.s)
    .slice(0, 8)
    .map((x) => ({ path: x.path, content: x.content }));

  await addMessage(id, "user", question, { kind: "question" });
  try {
    const result = await answerQuestion(question, index, samples, req.signal);
    await addMessage(id, "assistant", result.answer, { kind: "answer", references: result.references });
    return Response.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Moteur indisponible";
    return Response.json({ error: `Impossible de répondre pour l'instant : ${msg}` }, { status: 502 });
  }
}
