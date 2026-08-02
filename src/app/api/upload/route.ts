import { NextResponse } from 'next/server';
import { env } from '@/lib/env';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const imageFile = formData.get('image');

    if (!imageFile) {
      return NextResponse.json({ success: false, error: 'No image provided' }, { status: 400 });
    }

    if (!env.IMGBB_API_KEY) {
      return NextResponse.json({ success: false, error: 'IMGBB_API_KEY is not configured on the server' }, { status: 500 });
    }

    // Forward the formData to ImgBB
    const imgbbFormData = new FormData();
    imgbbFormData.append('image', imageFile);

    const uploadUrl = `${env.IMGBB_UPLOAD_URL}?key=${encodeURIComponent(env.IMGBB_API_KEY)}`;
    const res = await fetch(uploadUrl, {
      method: 'POST',
      body: imgbbFormData,
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      return NextResponse.json({ success: false, error: data?.error?.message || 'Upload to ImgBB failed' }, { status: res.status });
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error('Image upload proxy error:', error);
    return NextResponse.json({ success: false, error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
