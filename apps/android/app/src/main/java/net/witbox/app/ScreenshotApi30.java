package net.witbox.app;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Bitmap;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.view.Display;

import androidx.annotation.RequiresApi;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/** AccessibilityService.takeScreenshot wrapper, kept in its own class so API 26–29 never loads it. */
@RequiresApi(Build.VERSION_CODES.R)
final class ScreenshotApi30 {
    private ScreenshotApi30() {}

    /** Blocking; must not be called on the main thread. Returns a software ARGB_8888 bitmap. */
    static Bitmap capture(AccessibilityService svc) throws Exception {
        for (int attempt = 0; ; attempt++) {
            final CountDownLatch latch = new CountDownLatch(1);
            final AtomicReference<AccessibilityService.ScreenshotResult> out = new AtomicReference<>();
            final AtomicInteger err = new AtomicInteger(-1);
            svc.takeScreenshot(Display.DEFAULT_DISPLAY, Runnable::run,
                    new AccessibilityService.TakeScreenshotCallback() {
                        @Override
                        public void onSuccess(AccessibilityService.ScreenshotResult result) {
                            out.set(result);
                            latch.countDown();
                        }

                        @Override
                        public void onFailure(int errorCode) {
                            err.set(errorCode);
                            latch.countDown();
                        }
                    });
            if (!latch.await(10, TimeUnit.SECONDS)) throw new Exception("screenshot timed out");
            AccessibilityService.ScreenshotResult r = out.get();
            if (r != null) return toBitmap(r);
            int code = err.get();
            // The system rate-limits screenshots; wait and retry a few times.
            if (code == AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT && attempt < 4) {
                Thread.sleep(400);
                continue;
            }
            throw new Exception("screenshot failed (" + describe(code) + ")");
        }
    }

    private static String describe(int code) {
        switch (code) {
            case AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR:
                return "internal error";
            case AccessibilityService.ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS:
                return "no accessibility access";
            case AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT:
                return "too frequent";
            case AccessibilityService.ERROR_TAKE_SCREENSHOT_INVALID_DISPLAY:
                return "invalid display";
            default:
                return "code " + code;
        }
    }

    private static Bitmap toBitmap(AccessibilityService.ScreenshotResult r) throws Exception {
        HardwareBuffer hb = r.getHardwareBuffer();
        try {
            Bitmap hw = Bitmap.wrapHardwareBuffer(hb, r.getColorSpace());
            if (hw == null) throw new Exception("screenshot buffer unavailable");
            Bitmap sw = hw.copy(Bitmap.Config.ARGB_8888, false);
            hw.recycle();
            if (sw == null) throw new Exception("screenshot copy failed");
            return sw;
        } finally {
            try {
                hb.close();
            } catch (Throwable ignored) {
            }
        }
    }
}
