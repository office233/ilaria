import FranchiseApplyClient from "./FranchiseApplyClient";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Franciză de flotă Swypik — orașul tău, afacerea ta | Swypik",
    description:
        "Devino partenerul exclusiv Swypik în orașul tău: administrezi șoferii Go și curierii Food din zonă și câștigi comision din fiecare cursă și livrare. Teritorii exclusive, panou de management, investiție minimă.",
};

export default function FranchiseJoinPage() {
    return <FranchiseApplyClient />;
}
