"use client";

import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/ui/cn";

/**
 * Tabs (Radix): navigare cu săgeți, roluri ARIA corecte.
 *
 *   <Tabs defaultValue="all">
 *     <TabsList><TabsTrigger value="all">…</TabsTrigger>…</TabsList>
 *     <TabsContent value="all">…</TabsContent>
 *   </Tabs>
 *
 * Lista e scrollabilă orizontal (nu se rupe pe 3–4 rânduri la 360px) cu fade la margini.
 */
export const Tabs = TabsPrimitive.Root;

export const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: "underline" | "pill" }
>(function TabsList({ className, variant = "underline", ...props }, ref) {
  return (
    <TabsPrimitive.List
      ref={ref}
      data-variant={variant}
      className={cn(
        "no-scrollbar group/tabs flex w-full items-center overflow-x-auto [mask-image:linear-gradient(to_right,transparent,black_12px,black_calc(100%-12px),transparent)]",
        variant === "underline" ? "gap-4 border-b border-subtle px-3" : "gap-2 px-3 py-1",
        className,
      )}
      {...props}
    />
  );
});

export const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "relative inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap text-sm font-semibold text-muted transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50",
        // underline
        "group-data-[variant=underline]/tabs:after:absolute group-data-[variant=underline]/tabs:after:inset-x-0 group-data-[variant=underline]/tabs:after:bottom-0 group-data-[variant=underline]/tabs:after:h-0.5 group-data-[variant=underline]/tabs:after:rounded-full data-[state=active]:text-fg group-data-[variant=underline]/tabs:data-[state=active]:after:bg-fg",
        // pill
        "group-data-[variant=pill]/tabs:min-h-9 group-data-[variant=pill]/tabs:rounded-full group-data-[variant=pill]/tabs:bg-surface-2 group-data-[variant=pill]/tabs:px-3.5 group-data-[variant=pill]/tabs:data-[state=active]:bg-fg group-data-[variant=pill]/tabs:data-[state=active]:text-fg-inverse",
        className,
      )}
      {...props}
    />
  );
});

export const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return <TabsPrimitive.Content ref={ref} className={cn("focus-visible:outline-none", className)} {...props} />;
});
