import { FcGoogle } from "react-icons/fc";
import { Button } from "@/components/ui/button";

interface GoogleAuthButtonProps {
  label?: string;
}

export default function GoogleAuthButton({ label = "Continue with Google" }: GoogleAuthButtonProps) {
  return (
    <Button asChild type="button" variant="outline" className="w-full">
      <a href="/api/auth/google">
        <FcGoogle className="mr-2 h-5 w-5" aria-hidden="true" />
        {label}
      </a>
    </Button>
  );
}

export function AuthMethodDivider() {
  return (
    <div className="relative my-5" role="separator" aria-label="or">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t border-slate-200" />
      </div>
      <div className="relative flex justify-center text-xs uppercase">
        <span className="bg-white px-2 text-slate-500">or continue with email</span>
      </div>
    </div>
  );
}