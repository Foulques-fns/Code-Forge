import { listProjects } from "@/lib/forge/store";
import { checkEngineStatus } from "@/lib/ai/providers";
import { HomeClient } from "@/components/home-client";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [projects, engine] = await Promise.all([listProjects().catch(() => []), checkEngineStatus().catch(() => null)]);
  const serializable = projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    previewable: p.previewable,
    version: p.version,
    updatedAt: p.updatedAt.toISOString(),
    fileCount: p.fileCount,
    totalBytes: p.totalBytes,
    plan: p.plan as { stack?: { language?: string; framework?: string }; description?: string } | null,
  }));
  return <HomeClient projects={serializable} engine={engine} />;
}
