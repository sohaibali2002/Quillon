import { getSkill, listSkills } from "@/lib/skills";

export async function GET(req: Request) {
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
