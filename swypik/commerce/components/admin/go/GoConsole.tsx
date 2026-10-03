"use client";

import { useTranslations } from "next-intl";
import { AdminPage } from "@/components/admin/AdminPage";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import LiveTab from "./LiveTab";
import PricingTab from "./PricingTab";
import DriversTab from "./DriversTab";
import FoodOrdersTab from "./FoodOrdersTab";

export default function GoConsole() {
  const t = useTranslations("adminGo");
  return (
    <AdminPage title={t("title")}>
      <Tabs defaultValue="live">
        <TabsList variant="underline">
          <TabsTrigger value="live">{t("tabs.live")}</TabsTrigger>
          <TabsTrigger value="pricing">{t("tabs.pricing")}</TabsTrigger>
          <TabsTrigger value="food">{t("tabs.food")}</TabsTrigger>
          <TabsTrigger value="drivers">{t("tabs.drivers")}</TabsTrigger>
        </TabsList>
        <TabsContent value="live" className="pt-4">
          <LiveTab />
        </TabsContent>
        <TabsContent value="pricing" className="pt-4">
          <PricingTab />
        </TabsContent>
        <TabsContent value="food" className="pt-4">
          <FoodOrdersTab />
        </TabsContent>
        <TabsContent value="drivers" className="pt-4">
          <DriversTab />
        </TabsContent>
      </Tabs>
    </AdminPage>
  );
}
