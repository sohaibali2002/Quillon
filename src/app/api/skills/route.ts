async function secure(req: Request) {
  const gate = await guard(req);
  if (gate instanceof Response) return gate;
  return gate;
}

import { getSkill, listSkills } from "@/lib/skills";

import { guard } from "@/lib/guard";
export async function GET(req: Request) {
  const denied = await secure(req);
  if (denied instanceof Response) return denied;

  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    const skill = await getSkill(id);
    if (!skill) {
      return Response.json({ error: { message: "Skill not found." } }, { status: 404 });
    }
    return Response.json({ skill });
  }
  return Response.json({ skills: await listSkills() });
}
