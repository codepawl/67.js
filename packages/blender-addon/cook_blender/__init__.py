bl_info = {
    "name": "Cook renderer (Crucible)",
    "author": "CodePawl",
    "version": (0, 1, 0),
    "blender": (4, 2, 0),
    "location": "Render properties > Render Engine > Cook",
    "description": "Renders the scene with Cook, the Crucible GPU path tracer, through the native tracer package",
    "doc_url": "https://github.com/codepawl/crucible/blob/main/docs/blender-addon.md",
    "category": "Render",
}


def register():
    from . import engine
    engine.register()


def unregister():
    from . import engine
    engine.unregister()
