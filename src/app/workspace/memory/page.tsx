import { redirect } from "next/navigation";

export default function MemoryPage() {
  redirect("/workspace?panel=memory");
}
