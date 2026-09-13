import {
  forwardRef,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";

const control =
  "w-full rounded-lg border border-input bg-card text-foreground shadow-xs transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-60 read-only:bg-muted/60 aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/20";

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(control, "h-9.5 px-3 text-[13px]", className)}
    {...props}
  />
));
Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(control, "resize-y px-3 py-2.5 text-[13px]", className)}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <div className="relative inline-grid w-full">
    <select
      ref={ref}
      className={cn(
        control,
        "h-9.5 appearance-none py-0 pr-9 pl-3 text-[13px]",
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <ChevronDown
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted-foreground"
    />
  </div>
));
Select.displayName = "Select";

export function Label({
  className,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        "text-[13px] font-medium text-foreground/90 select-none",
        className,
      )}
      {...props}
    />
  );
}

/** Optional/required marker that sits beside a label. */
export function FieldHint({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "ml-2 text-[11px] font-normal text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function FieldError({
  children,
  id,
}: {
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <small id={id} className="text-[12px] text-destructive">
      {children}
    </small>
  );
}

/** Native checkbox/radio, restyled to the brand accent. */
export const Checkbox = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, type = "checkbox", ...props }, ref) => (
  <input
    ref={ref}
    type={type}
    className={cn(
      "size-4 shrink-0 cursor-pointer accent-navy-700 dark:accent-navy-300",
      className,
    )}
    {...props}
  />
));
Checkbox.displayName = "Checkbox";
