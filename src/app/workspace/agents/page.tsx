import { redirect } from "next/navigation";

export default function AgentsPage() {
  redirect("/workspace?panel=agents");
}
