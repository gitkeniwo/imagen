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
    # Tags to auto-archive this task into (applied to output + inputs).
    tagIds: list[int] = Field(default_factory=list)
    # Client-side queue task id, used to publish live progress (see PROGRESS).
    clientTaskId: Optional[str] = None


class ManualGenerationRequest(BaseModel):
    """A generation row created/edited from results produced elsewhere (no Vertex call)."""
    prompt: str = ""
    model: str
    aspectRatio: Optional[str] = None
    resolution: Optional[str] = None
    status: str = "success"  # "success" | "blocked" | "error" | "note"
    source: str = "manual"   # "vertex" | "manual" — forced to "manual" when status is "note"
    errorMessage: Optional[str] = None
    inputImageIds: list[int] = Field(default_factory=list)
    outputImageId: Optional[int] = None
    tagIds: list[int] = Field(default_factory=list)
    createdAt: Optional[str] = None  # ISO-8601; defaults to now if omitted


class TagCreate(BaseModel):
    name: str
    color: Optional[str] = None


class TagUpdate(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None
    coverImageId: Optional[int] = None


class BatchTag(BaseModel):
    """Add or remove a set of tags on a set of images."""
    imageIds: list[int] = Field(default_factory=list)
    tagIds: list[int] = Field(default_factory=list)
    op: str = "add"  # "add" | "remove"


class VertexConfig(BaseModel):
    project: str
    location: Optional[str] = None  # defaults to "global" on the server


class ImagePatch(BaseModel):
    starred: Optional[bool] = None
    filename: Optional[str] = None
    note: Optional[str] = None
