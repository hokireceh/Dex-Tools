import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle, ArrowLeft } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardContent className="pt-8 pb-8 flex flex-col items-center text-center gap-4">
          <div className="rounded-full bg-destructive/10 p-4">
            <AlertCircle className="h-10 w-10 text-destructive" />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-bold text-foreground">Halaman Tidak Ditemukan</h1>
            <p className="text-sm text-muted-foreground">
              Halaman yang kamu cari tidak ada atau sudah dipindahkan.
            </p>
          </div>
          <Link href="/">
            <Button variant="outline" className="gap-2 mt-2">
              <ArrowLeft className="h-4 w-4" />
              Kembali ke Dashboard
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
