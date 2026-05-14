import { type ProviderKind, type ServerProvider } from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { memo, useMemo, useState } from "react";
import type { VariantProps } from "class-variance-authority";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { useSettings } from "../../hooks/useSettings";
import { useDeepSeekBalance } from "../../lib/deepseekBalanceState";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import {
  ArisIcon,
  ClaudeAI,
  CursorIcon,
  DeepSeekIcon,
  Gemini,
  Icon,
  OpenAI,
  OpenCodeIcon,
} from "../Icons";
import { cn } from "~/lib/utils";
import { getProviderSnapshot } from "../../providerModels";

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
  hidden?: boolean;
} {
  return option.available;
}

// Cosmetic relabel (2026-05-10): hidden options (currently the legacy
// `"aris"` provider) are filtered out of every list the picker renders.
// They stay in PROVIDER_OPTIONS so TypeScript exhaustiveness across
// ProviderKind keeps working.
function isVisibleProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): boolean {
  return option.hidden !== true;
}

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  aris: ArisIcon,
  deepseek: DeepSeekIcon,
  cursor: CursorIcon,
};

export const AVAILABLE_PROVIDER_OPTIONS =
  PROVIDER_OPTIONS.filter(isVisibleProviderOption).filter(isAvailableProviderOption);
const UNAVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isVisibleProviderOption).filter(
  (option) => !option.available,
);
const COMING_SOON_PROVIDER_OPTIONS = [
  { id: "opencode", label: "OpenCode", icon: OpenCodeIcon },
  { id: "gemini", label: "Gemini", icon: Gemini },
] as const;

// Brand color per provider mark — keeps each icon in its recognizable
// identity color instead of flat muted gray.
//   - claudeAgent → Anthropic terracotta
//   - deepseek    → DeepSeek blue (#5786FE, matches the simple-icons mark)
//   - codex/cursor → OpenAI + Cursor marks are monochrome by brand, so
//     full-contrast `text-foreground` (black on light / white on dark)
//     reads cleanest and stays theme-correct
//   - aris/opencode → no single brand hex (aris is the hidden legacy
//     provider; opencode is intentionally mono) → fall through to the
//     caller's fallback class
//   - gemini → omitted on purpose: its mark carries a baked-in gradient
//     fill, so a text-color class would be a no-op anyway
// Keyed by plain string so it also covers the "coming soon" option ids
// (`opencode`, `gemini`) that aren't part of ProviderPickerKind.
const PROVIDER_ICON_COLOR_CLASS: Record<string, string> = {
  claudeAgent: "text-[#d97757]",
  deepseek: "text-[#5786FE]",
  codex: "text-foreground",
  cursor: "text-foreground",
};

function providerIconClassName(provider: string, fallbackClassName: string): string {
  return PROVIDER_ICON_COLOR_CLASS[provider] ?? fallbackClassName;
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onProviderModelChange: (provider: ProviderKind, model: string) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderOptions = props.modelOptionsByProvider[activeProvider];

  // Aris-exclusive mode (2026-05-11): once the user has activated Aris
  // (subscription key entered AND cloud has verified it by returning a
  // balance), collapse the provider sub-menu down to Aris only — Codex
  // and Claude entries become noise for a paying Aris user. Existing
  // Codex/Claude threads keep working via `props.lockedProvider`, which
  // bypasses this filter (locked branch below).
  //
  // Verification is strict on purpose: `balanceCents !== null` proves the
  // cloud accepted the token. A user with a typo'd key won't get locked
  // out of the other providers — they'll see all three until the key
  // verifies.
  const deepseekSettings = useSettings((s) => s.providers.deepseek);
  const deepseekBalance = useDeepSeekBalance();
  const arisExclusive =
    deepseekSettings.enabled &&
    deepseekSettings.cloudToken.length > 0 &&
    deepseekBalance.balanceCents !== null;

  const visibleProviderOptions = useMemo(
    () =>
      arisExclusive
        ? AVAILABLE_PROVIDER_OPTIONS.filter((option) => option.value === "deepseek")
        : AVAILABLE_PROVIDER_OPTIONS,
    [arisExclusive],
  );
  const selectedModelLabel =
    selectedProviderOptions.find((option) => option.slug === props.model)?.name ?? props.model;
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[activeProvider];
  const handleModelChange = (provider: ProviderKind, value: string) => {
    if (props.disabled) return;
    if (!value) return;
    const resolvedModel = resolveSelectableModel(
      provider,
      value,
      props.modelOptionsByProvider[provider],
    );
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel);
    setIsMenuOpen(false);
  };

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          setIsMenuOpen(false);
          return;
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56 sm:px-3",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn(
            "flex min-w-0 w-full box-border items-center gap-2 overflow-hidden",
            props.compact ? "max-w-36 sm:pl-1" : undefined,
          )}
        >
          <ProviderIcon
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0",
              providerIconClassName(activeProvider, "text-muted-foreground/70"),
              props.activeProviderIconClassName,
            )}
          />
          <span className="min-w-0 flex-1 truncate">{selectedModelLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup align="start">
        {props.lockedProvider !== null ? (
          <MenuGroup>
            <MenuRadioGroup
              value={props.model}
              onValueChange={(value) => handleModelChange(props.lockedProvider!, value)}
            >
              {props.modelOptionsByProvider[props.lockedProvider].map((modelOption) => (
                <MenuRadioItem
                  key={`${props.lockedProvider}:${modelOption.slug}`}
                  value={modelOption.slug}
                  onClick={() => setIsMenuOpen(false)}
                >
                  {modelOption.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : (
          <>
            {visibleProviderOptions.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              const liveProvider = props.providers
                ? getProviderSnapshot(props.providers, option.value)
                : undefined;
              if (liveProvider && liveProvider.status !== "ready") {
                const unavailableLabel = !liveProvider.enabled
                  ? "Disabled"
                  : !liveProvider.installed
                    ? "Not installed"
                    : "Unavailable";
                return (
                  <MenuItem key={option.value} disabled>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 opacity-80",
                        providerIconClassName(option.value, "text-muted-foreground/85"),
                      )}
                    />
                    <span>{option.label}</span>
                    <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                      {unavailableLabel}
                    </span>
                  </MenuItem>
                );
              }
              return (
                <MenuSub key={option.value}>
                  <MenuSubTrigger>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0",
                        providerIconClassName(option.value, "text-muted-foreground/85"),
                      )}
                    />
                    {option.label}
                  </MenuSubTrigger>
                  <MenuSubPopup className="[--available-height:min(24rem,70vh)]" sideOffset={4}>
                    <MenuGroup>
                      <MenuRadioGroup
                        value={props.provider === option.value ? props.model : ""}
                        onValueChange={(value) => handleModelChange(option.value, value)}
                      >
                        {props.modelOptionsByProvider[option.value].map((modelOption) => (
                          <MenuRadioItem
                            key={`${option.value}:${modelOption.slug}`}
                            value={modelOption.slug}
                            onClick={() => setIsMenuOpen(false)}
                          >
                            {modelOption.name}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </MenuSubPopup>
                </MenuSub>
              );
            })}
            {UNAVAILABLE_PROVIDER_OPTIONS.length > 0 && <MenuDivider />}
            {UNAVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              return (
                <MenuItem key={option.value} disabled>
                  <OptionIcon
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0 opacity-80",
                      providerIconClassName(option.value, "text-muted-foreground/85"),
                    )}
                  />
                  <span>{option.label}</span>
                  <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                    Coming soon
                  </span>
                </MenuItem>
              );
            })}
            {UNAVAILABLE_PROVIDER_OPTIONS.length === 0 && <MenuDivider />}
            {COMING_SOON_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = option.icon;
              return (
                <MenuItem key={option.id} disabled>
                  <OptionIcon
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0 opacity-80",
                      providerIconClassName(option.id, "text-muted-foreground/85"),
                    )}
                  />
                  <span>{option.label}</span>
                  <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                    Coming soon
                  </span>
                </MenuItem>
              );
            })}
          </>
        )}
      </MenuPopup>
    </Menu>
  );
});
