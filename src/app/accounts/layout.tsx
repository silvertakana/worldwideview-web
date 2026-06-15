import { redirect } from "next/navigation";
import { createClient } from "../../lib/supabase/server";
import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";
import styles from "./accounts.module.css";

export default async function AccountsLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect("/login?next=/accounts");

    return (
        <div style={{ display: "flex", minHeight: "100vh" }}>
            <Sidebar />
            <main className={styles.contentArea}>
                <MobileNav />
                {children}
            </main>
        </div>
    );
}
