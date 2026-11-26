import { redirect } from "next/navigation";

export default function SandboxPage() {
  redirect("/workspace?panel=sandbox");
}
