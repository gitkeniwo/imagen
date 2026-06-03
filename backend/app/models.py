"""Pydantic request/response models."""
from typing import Optional

from pydantic import BaseModel, Field


class GenerateRequest(BaseModel):
    prompt: str = ""
    model: str
    aspectRatio: Optional[str] = None
    resolution: Optional[str] = None  # "1K" | "2K" | "4K"
    outputFormat: str = "image/jpeg"  # "image/jpeg" | "image/png"
    inputImageIds: list[int] = Field(default_factory=list)
    uploadImageIds: list[int] = Field(default_factory=list)


class VertexConfig(BaseModel):
    project: str
    location: Optional[str] = None  # defaults to "global" on the server


class ImagePatch(BaseModel):
    starred: Optional[bool] = None
    filename: Optional[str] = None
