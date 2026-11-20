import type { Page } from '@playwright/test';

export const button = (page: Page, text: string) => page.getByRoleUI5('Button', { text });

export const input = (page: Page, label: string) => page.getByRoleUI5('Input', { label });
