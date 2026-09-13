/**
 * The `<script setup lang="ts">` body of a Vue page, as a plain `.ts` module
 * so it can be checked by `tsc` rather than `vue-tsc` — `defineProps` is a
 * real (runtime-throwing) export of `vue`, so its typing is identical here.
 */
import { type PageProps, route } from "@blokjs/inertia-client";
import { usePage } from "@inertiajs/vue3";
import { defineProps } from "vue";

const props = defineProps<PageProps<"Orders/Index">>();

// Test 11: the generated InertiaConfig augmentation types the stock hook.
export const email: string = usePage().props.auth.email;
export const firstError: string | undefined = props.errors.title;
export const total: number = props.orders[0].total;
export const href = route("orders.show", { id: props.orders[0].id });
