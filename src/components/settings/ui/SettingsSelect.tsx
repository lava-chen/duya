import * as React from "react";
import { Select } from "antd";
import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

export interface SettingsSelectProps {
  label?: string;
  description?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  className?: string;
  placeholder?: string;
}

export function SettingsSelect({
  label,
  description,
  value,
  onValueChange,
  options,
  disabled,
  className,
  placeholder,
}: SettingsSelectProps) {
  const id = React.useId();

  return (
    <div className={cn("px-4 py-3.5", className)}>
      {(label || description) && (
        <div className="mb-2">
          {label && (
            <label htmlFor={id} className="text-sm font-medium text-foreground block">
              {label}
            </label>
          )}
          {description && (
            <span className="text-sm text-muted-foreground">{description}</span>
          )}
        </div>
      )}
      <Select
        id={id}
        value={value}
        onChange={onValueChange}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full settings-select-antd"
        classNames={{ popup: { root: "settings-select-dropdown" } }}
        options={options.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
      />
    </div>
  );
}

export function SettingsSelectRow({
  label,
  description,
  value,
  onValueChange,
  options,
  disabled,
  className,
}: SettingsSelectProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between",
        disabled && "opacity-50",
        className
      )}
    >
      <div className="min-w-0 flex-1 sm:pr-4">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="text-sm text-muted-foreground mt-0">{description}</div>
        )}
      </div>
      <Select
        value={value}
        onChange={onValueChange}
        disabled={disabled}
        className="w-full settings-select-antd settings-select-row sm:w-[21rem]"
        popupMatchSelectWidth={false}
        classNames={{ popup: { root: "settings-select-dropdown" } }}
        options={options.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
      />
    </div>
  );
}
